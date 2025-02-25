/*
 * Copyright 2016 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const path = require('path')
const fs = require('fs')
const geolib = require('geolib')

const subscribrPeriod = 1000

module.exports = function (app) {
  var plugin = {}
  var alarm_sent = false
  var prev_anchorState = false
  let onStop = []
  var positionInterval
  var positionAlarmSent = false
  var configuration
  var delayStartTime
  var lastTrueHeading
  var lastPosition
  var lastPositionTime
  var saveOptionsTimer
  var track = []
  var incompleteAnchorTimer
  var sentIncompleteAnchorAlarm
  var statePath
  var state

  plugin.start = function (props) {
    configuration = props
    try {
      statePath = path.join(app.getDataDirPath(), 'state.json')

      if (fs.existsSync(statePath)) {
        let stateString
        try {
          stateString = fs.readFileSync(statePath, 'utf8')
        } catch (e) {
          app.error('Could not read state ' + statePath + ' - ' + e)
          return
        }
        try {
          state = JSON.parse(stateString)
        } catch (e) {
          app.error('Could not parse state ' + e)
          return
        }
      } else {
        state = { on: false }

        var isOn = configuration['on']
        if (isOn) {
          state.on = isOn
          state.position = configuration['position']
          state.radius = configuration['radius']
          saveState()
        }
      }

      if (
        typeof state.on != 'undefined' &&
        state.on &&
        typeof state.position != 'undefined' &&
        typeof state.radius != 'undefined'
      ) {
        startWatchingPosistion()
      }

      if (app.registerActionHandler) {
        app.registerActionHandler(
          'vessels.self',
          `navigation.anchor.position`,
          putPosition
        )

        app.registerActionHandler(
          'vessels.self',
          `navigation.anchor.maxRadius`,
          putRadius
        )

        app.registerActionHandler(
          'vessels.self',
          `navigation.anchor.rodeLength`,
          putRodeLength
        )
      }

      app.handleMessage(plugin.id, {
        updates: [
          {
            meta: [
              {
                path: 'navigation.anchor.bearingTrue',
                value: { units: 'rad' }
              },
              {
                path: 'navigation.anchor.apparentBearing',
                value: { units: 'rad' }
              },
              {
                path: 'navigation.anchor.rodeLength',
                value: { units: 'm' }
              },
              {
                path: 'navigation.anchor.fudgeFactor',
                value: { units: 'm' }
              },
              {
                path: 'navigation.anchor.distanceFromBow',
                value: { units: 'm' }
              }
            ]
          }
        ]
      })
    } catch (e) {
      plugin.started = false
      app.error('error: ' + e)
      console.error(e.stack)
      return e
    }
  }

  function saveState() {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    savePluginOptions()
  }

  function savePluginOptions() {
    if (app.savePluginOptionsSync) {
      app.savePluginOptionsSync(configuration)
    } else if (!saveOptionsTimer) {
      saveOptionsTimer = setTimeout(() => {
        app.debug('saving options..')
        saveOptionsTimer = undefined
        app.savePluginOptions(configuration, (err) => {
          if (err) {
            app.error(err)
          }
        })
      }, 1000)
    }
  }

  function putRadius(context, path, value) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'navigation.anchor.maxRadius',
              value: value
            }
          ]
        }
      ]
    })

    state.radius = value
    configuration['radius'] = value
    if (state.position) {
      state.on = true
      configuration['on'] = true
      startWatchingPosistion()
    }

    try {
      saveState()
      return { state: 'SUCCESS' }
    } catch (err) {
      app.error(err)
      return { state: 'FAILURE', message: err.message }
    }
  }

  function putRodeLength(context, path, value) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'navigation.anchor.rodeLength',
              value: value
            }
          ]
        }
      ]
    })

    let res = setManualAnchor(null, value)

    if (res.code != 200) {
      return { state: 'FAILURE', message: res.message }
    } else {
      return { state: 'SUCCESS' }
    }
  }

  function putPosition(context, path, value) {
    try {
      if (value == null) {
        raiseAnchor()
      } else {
        var delta = getAnchorDelta(
          app,
          null,
          value,
          null,
          state.radius,
          true,
          null,
          state.rodeLength
        )
        app.handleMessage(plugin.id, delta)

        state.position = {
          latitude: value.latitude,
          longitude: value.longitude,
          altitude: value.altitude
        }

        if (state.radius) {
          state.on = true
          configuration['on'] = true
          startWatchingPosistion()
        }

        saveState()
      }
      return { state: 'SUCCESS' }
    } catch (err) {
      app.error(err)
      return { state: 'FAILURE', message: err.message }
    }
  }

  plugin.stop = function () {
    if (alarm_sent) {
      var alarmDelta = getAnchorAlarmDelta(app, 'normal')
      app.handleMessage(plugin.id, alarmDelta)
    }
    alarm_sent = null
    var delta = getAnchorDelta(app, null, null, null, null, false, null, null)
    app.handleMessage(plugin.id, delta)
    stopWatchingPosition()
  }

  function stopWatchingPosition() {
    onStop.forEach((f) => f())
    onStop = []
    track = []
    if (positionInterval) {
      clearInterval(positionInterval)
      positionInterval = null
    }
  }

  function startWatchingPosistion() {
    if (onStop.length > 0) return

    if ( configuration.noPositionAlarmTime != 0 ) {
      positionInterval = setInterval(() => {
        app.debug('checking last position...')
        if ( !lastPositionTime || Date.now() - lastPositionTime > configuration.noPositionAlarmTime * 1000 ) {
          positionAlarmSent = true
          sendAnchorAlarm(configuration.state, app, plugin, 'No position received')
        } else if ( alarm_sent == null && positionAlarmSent ) {
          var delta = getAnchorAlarmDelta(app, "normal")
          app.handleMessage(plugin.id, delta)
          positionAlarmSent = false
        }
      }, (configuration.noPositionAlarmTime/2.0) * 1000)
    }

    track = []
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [
          {
            path: 'navigation.position',
            period: subscribrPeriod
          },
          {
            path: 'navigation.headingTrue',
            period: subscribrPeriod
          }
        ]
      },
      onStop,
      (err) => {
        app.error(err)
        app.setProviderError(err)
      },
      (delta) => {
        let position, trueHeading

        if (delta.updates) {
          delta.updates.forEach((update) => {
            if (update.values) {
              update.values.forEach((vp) => {
                if (vp.path === 'navigation.position') {
                  position = vp.value
                  // Track the positon. Only record the position every minute.
                  if (
                    track.length == 0 ||
                    track[track.length - 1].time < Date.now() - 60 * 1000
                  ) {
                    track.push({
                      position: position,
                      time: Date.now()
                    })
                    if (track.length > 24 * 60) {
                      // Keep only the last 24 hours of track to avoid memory issues
                      track.shift()
                    }
                  }
                } else if (vp.path === 'navigation.headingTrue') {
                  trueHeading = vp.value
                }
              })
            }
          })
        }

        if (position) {
          var anchorState
          lastPosition = position
          lastPositionTime = Date.now()
          anchorState = checkPosition(
            app,
            plugin,
            state.radius,
            position,
            state.position,
            state.rodeLength
          )
          var was_sent = alarm_sent
          alarm_sent = anchorState
          if (was_sent && !anchorState) {
            //clear it
            app.debug('clear_it')
            var anchorDelta = getAnchorAlarmDelta(app, 'normal')
            app.handleMessage(plugin.id, anchorDelta)
            delayStartTime = undefined
            alarm_sent = null
          } else if (!was_sent || prev_anchorState != anchorState) {
            sendAnchorAlarm(anchorState, app, plugin)
          }
          prev_anchorState = anchorState
        }

        if (typeof trueHeading !== 'undefined' || position) {
          if (typeof trueHeading !== 'undefined') {
            lastTrueHeading = trueHeading
          }
          computeAnchorApparentBearing(
            lastPosition,
            state.position,
            lastTrueHeading
          )
        }
      }
    )
  }

  function clearIncompleteAlarm() {
    app.debug('clearIncompleteAlarm')
    if (incompleteAnchorTimer) {
      clearTimeout(incompleteAnchorTimer)
      incompleteAnchorTimer = undefined
    }
    if (sentIncompleteAnchorAlarm) {
      sendAnchorAlarm('normal', app, plugin)
      sentIncompleteAnchorAlarm = false
    }
  }

  function raiseAnchor() {
    app.debug('raise anchor')

    var delta = getAnchorDelta(app, null, null, null, null, false, null, null)
    app.handleMessage(plugin.id, delta)

    clearIncompleteAlarm()
    if (alarm_sent) {
      var alarmDelta = getAnchorAlarmDelta(app, 'normal')
      app.handleMessage(plugin.id, alarmDelta)
    }
    alarm_sent = null
    delayStartTime = undefined

    delete state.position
    delete state.radius
    delete state.rodeLength
    delete configuration['radius']
    state.on = false
    configuration['on'] = false

    stopWatchingPosition()
    
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'navigation.anchor.apparentBearing',
              value: null
            },
            {
              path: 'navigation.anchor.bearingTrue',
              value: null
            }
          ]
        }
      ]
    })

    saveState()
  }

  plugin.registerWithRouter = function (router) {
    router.post('/dropAnchor', (req, res) => {
      var vesselPosition = app.getSelfPath('navigation.position')
      if (vesselPosition && vesselPosition.value)
        vesselPosition = vesselPosition.value

      if (typeof vesselPosition == 'undefined') {
        app.debug('no position available')
        res.status(403)
        res.json({
          statusCode: 403,
          state: 'FAILED',
          message: 'no position available'
        })
      } else {
        let position = computeBowLocation(
          vesselPosition,
          app.getSelfPath('navigation.headingTrue.value')
        )

        app.debug(
          'set anchor position to: ' +
            position.latitude +
            ' ' +
            position.longitude
        )
        var radius = req.body['radius']
        if (typeof radius == 'undefined') {
          radius = null
        }

        var depth = app.getSelfPath('environment.depth.belowSurface.value')

        var delta = getAnchorDelta(
          app,
          vesselPosition,
          position,
          0,
          radius,
          true,
          depth,
          null
        )
        app.handleMessage(plugin.id, delta)

        sendAnchorAlarm('normal', app, plugin)

        app.debug('anchor delta: ' + JSON.stringify(delta))

        state.position = {
          latitude: position.latitude,
          longitude: position.longitude
        }
        if (depth) {
          state.position.altitude = depth * -1
        }
        state.radius = radius
        configuration['radius'] = radius
        state.on = true
        configuration['on'] = true

        let alarmTime = configuration.incompleteAnchorAlarmTime

        if (alarmTime != 0) {
          if (alarmTime === undefined) alarmTime = 10

          incompleteAnchorTimer = setTimeout(() => {
            sendAnchorAlarm(
              'alarm',
              app,
              plugin,
              'The anchoring process has not been completed'
            )
            sentIncompleteAnchorAlarm = true
            incompleteAnchorTimer = undefined
          }, alarmTime * 60 * 1000)
        }

        startWatchingPosistion()

        try {
          saveState()
          res.json({
            statusCode: 200,
            state: 'COMPLETED'
          })
        } catch (err) {
          app.error(err)
          res.status(500)
          res.json({
            statusCode: 500,
            state: 'FAILED',
            message: "can't save config"
          })
        }
      }
    })

    router.post('/setRadius', (req, res) => {
      let position = app.getSelfPath('navigation.position')
      if (position.value) position = position.value
      if (typeof position == 'undefined') {
        app.debug('no position available')
        res.status(403)
        res.json({
          statusCode: 403,
          state: 'FAILED',
          message: 'no position available'
        })
      } else {
        if (typeof state.position == 'undefined') {
          res.status(403)
          res.json({
            statusCode: 403,
            state: 'FAILED',
            message: 'the anchor has not been dropped'
          })
          return
        }

        clearIncompleteAlarm()
        var radius = req.body['radius']
        if (typeof radius == 'undefined') {
          app.debug('state: %o', state)
          radius = calc_distance(
            state.position.latitude,
            state.position.longitude,
            position.latitude,
            position.longitude
          )

          var fudge = configuration.fudge
          if (typeof fudge !== 'undefined' && fudge > 0) {
            radius += fudge
          }

          calculateRodeLength(position)

          app.debug('calc_distance: ' + radius)
        } else {
          radius = Number(radius)
        }

        app.debug('set anchor radius: ' + radius)

        var delta = getAnchorDelta(
          app,
          position,
          state.position,
          null,
          radius,
          false,
          state.position.depth * -1,
          state.rodeLength
        )
        app.handleMessage(plugin.id, delta)

        state.radius = radius
        configuration['radius'] = radius

        try {
          saveState()
          res.json({
            statusCode: 200,
            state: 'COMPLETED'
          })
        } catch (err) {
          app.error(err)
          res.status(500)
          res.json({
            statusCode: 500,
            state: 'FAILED',
            message: "can't save config"
          })
        }
      }
    })

    router.post('/setRodeLength', (req, res) => {
      clearIncompleteAlarm()
      let length = req.body['length']
      let depth = req.body['depth']
      if (typeof length == 'undefined') {
        res.status(403)
        res.json({
          statusCode: 403,
          state: 'FAILED',
          message: 'no length provided'
        })
        return
      }

      if (typeof state.position == 'undefined') {
        res.status(403)
        res.json({
          statusCode: 403,
          state: 'FAILED',
          message: 'the anchor has not been dropped'
        })
        return
      }

      var maxRadius = length

      if (!depth) {
        var sd = app.getSelfPath('environment.depth.belowSurface.value')
        if (typeof sd != 'undefined') {
          depth = sd
        }
      }

      if (depth && length) {
        let height = configuration.bowHeight
        let heightFromBow = depth
        if (typeof height !== 'undefined' && height > 0) {
          heightFromBow += height
        }
        app.debug(`length: ${length} height: ${heightFromBow}`)
        maxRadius = length * length - heightFromBow * heightFromBow
        maxRadius = Math.sqrt(maxRadius)
      }

      app.debug('depth: ' + depth)
      app.debug('maxRadius: ' + maxRadius)

      let gps_dist = app.getSelfPath('sensors.gps.fromBow.value')
      if (typeof gps_dist != 'undefined') {
        maxRadius += gps_dist
      }

      let fudge = configuration.fudge
      if (typeof fudge !== 'undefined' && fudge > 0) {
        app.debug('fudge radius by ' + fudge)
        maxRadius += fudge
      }

      app.debug('set anchor radius: ' + maxRadius)

      let delta = getAnchorDelta(
        app,
        null,
        state.position,
        null,
        maxRadius,
        false,
        null,
        length
      )
      app.handleMessage(plugin.id, delta)

      state.radius = maxRadius
      configuration['radius'] = maxRadius
      state.rodeLength = length

      try {
        saveState()
        res.json({
          statusCode: 200,
          state: 'COMPLETED'
        })
      } catch (err) {
        app.error(err)
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/raiseAnchor', (req, res) => {
      try {
        raiseAnchor()
        res.json({
          statusCode: 200,
          state: 'COMPLETED'
        })
      } catch (err) {
        app.error(err)
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/setAnchorPosition', (req, res) => {
      var old_pos = app.getSelfPath('navigation.anchor.position.value')
      var depth

      if (old_pos && old_pos.altitude) {
        depth = old_pos.altitude
      }

      var position = req.body['position']

      var maxRadius = app.getSelfPath('navigation.anchor.maxRadius.value')

      var delta = getAnchorDelta(
        app,
        null,
        position,
        null,
        maxRadius,
        false,
        depth,
        state.rodeLength
      )

      app.debug('setAnchorPosition: ' + JSON.stringify(delta))
      app.handleMessage(plugin.id, delta)

      state.position = {
        latitude: position.latitude,
        longitude: position.longitude,
        altitude: depth
      }

      try {
        saveState()
        res.json({
          statusCode: 200,
          state: 'COMPLETED'
        })
      } catch (err) {
        app.error(err)
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/setManualAnchor', (req, res) => {
      app.debug('set manual anchor')
      let depth = req.body['anchorDepth']
      let rode = req.body['rodeLength']
      let result = setManualAnchor(depth, rode)
      res.status(result.statusCode).json(result)
    })

    router.get('/getTrack', (req, res) => {
      res.json(track)
    })
  }

  function calculateRodeLength(vesselPosition) {
    let heading = app.getSelfPath('navigation.headingTrue.value')
    if (heading !== undefined && state.position.altitude !== undefined) {
      let bowPosition = computeBowLocation(vesselPosition, heading)
      let distanceFromBow = calc_distance(
        bowPosition.latitude,
        bowPosition.longitude,
        state.position.latitude,
        state.position.longitude
      )

      var height = configuration.bowHeight || 0
      var heightFromBow = state.position.altitude * -1
      heightFromBow += height
      state.rodeLength = Math.sqrt(
        heightFromBow * heightFromBow + distanceFromBow * distanceFromBow
      )
    }
  }

  function setManualAnchor(depth, rode) {
    let position = app.getSelfPath('navigation.position.value')
    if (!position) {
      app.debug('no position available')
      return {
        statusCode: 403,
        state: 'FAILED',
        message: 'no position available'
      }
    }

    let heading = app.getSelfPath('navigation.headingTrue.value')

    if (typeof heading === 'undefined') {
      heading = app.getSelfPath('navigation.headingMagnetic.value')
      if (typeof heading === 'undefined') {
        app.debug('no heading available')
        return {
          statusCode: 403,
          state: 'FAILED',
          message: 'no heading available'
        }
      }
    }

    app.debug('anchor rode: ' + rode + ' depth: ' + depth)

    rode = parseInt(rode) ?? undefined
    if (typeof rode !== 'number' || isNaN(rode)) {
      app.debug('invalid rode value')
      return {
        statusCode: 403,
        state: 'FAILED',
        message: 'invalid rode value'
      }
    }

    let maxRadius = rode

    if (typeof depth === 'undefined') {
      let sd = app.getSelfPath('environment.depth.belowSurface.value')
      if (typeof sd === 'number' && !isNaN(sd)) {
        depth = sd
      }
      else {
        app.debug('no depth available')
        return {
          statusCode: 403,
          state: 'FAILED',
          message: 'no depth available'
        }
      }
    }

    if (depth !== 0 && rode !== 0) {
      let height = configuration.bowHeight
      let heightFromBow = depth
      if (typeof height !== 'undefined' && height > 0) {
        heightFromBow += height
      }
      //maxRadius = (depth * depth) + (rode * rode)
      maxRadius = Math.abs(rode * rode - heightFromBow * heightFromBow)
      maxRadius = Math.sqrt(maxRadius)
      if (typeof maxRadius !== 'number' || isNaN(maxRadius)) {
        app.debug('invalid maxRadius value')
        return {
          statusCode: 403,
          state: 'FAILED',
          message: 'invalid maxRadius value'
        }
      }
    }

    app.debug('depth: ' + depth)
    app.debug('heading: ' + heading)
    app.debug('maxRadius: ' + maxRadius)

    let gps_dist = app.getSelfPath('sensors.gps.fromBow.value')
    if (typeof gps_dist != 'undefined') {
      maxRadius += gps_dist
    }

    let curRadius = maxRadius
    let fudge = configuration.fudge
    if (typeof fudge !== 'undefined' && fudge > 0) {
      app.debug('fudge radius by ' + fudge)
      maxRadius += fudge
    }

    let newposition = calc_position_from(app, position, heading, curRadius)

    let delta = getAnchorDelta(
      app,
      position,
      newposition,
      curRadius,
      maxRadius,
      true,
      depth,
      rode
    )
    app.handleMessage(plugin.id, delta)

    state.on = true
    configuration['on'] = true
    state.radius = maxRadius
    configuration['radius'] = maxRadius
    state.position = newposition
    if (rode) {
      state.rodeLength = rode
    }

    if (depth) {
      state.position.altitude = depth * -1
    }

    startWatchingPosistion()

    try {
      saveState()
      return { statusCode: 200, state: 'COMPLETED', message: 'ok' }
    } catch (err) {
      app.error(err)
      return { statusCode: 501, state: 'FAILED', message: err.message }
    }
  }

  plugin.id = 'anchoralarm'
  plugin.name = 'Anchor Alarm'
  plugin.description =
    "Plugin that checks the vessel position to see if there's anchor drift"

  plugin.schema = {
    title: 'Anchor Alarm',
    type: 'object',
    required: ['radius', 'active'],
    properties: {
      delay: {
        type: 'number',
        title:
          'Send a notification after the boat has been outside of the alarms radius for the given number of seconds (0 for imediate)',
        default: 0
      },
      warningPercentage: {
        type: 'number',
        title: 'Percentage of alarm radius to set a warning (0 for none)',
        default: 0
      },
      warningNotification: {
        type: 'boolean',
        title: 'Send a notification when past the warning percentage',
        default: false
      },
      noPositionAlarmTime: {
        type: 'number',
        title:
          'Send a notification if no position is received for the given number of seconds (0 to disable)',
        default: 10
      },
      fudge: {
        type: 'number',
        title: 'Alarm Radius Fudge Factor (m)',
        description:
          'When setting an automatic alarm, this will be added to the alarm radius to handle gps accuracy or a slightly off anchor position',
        default: 0
      },
      bowHeight: {
        type: 'number',
        title: 'The height of the bow from the water (m)',
        description: 'This is used to calculate rode length',
        default: 0
      },
      state: {
        title: 'State',
        description:
          'When an anchor drift notifcation is sent, this wil be used as the notitication state',
        type: 'string',
        default: 'emergency',
        enum: ['alert', 'warn', 'alarm', 'emergency']
      },
      incompleteAnchorAlarmTime: {
        type: 'number',
        title: 'Incomplete Anchor Alarm Time',
        description:
          'An alarm will be sent after this many minutes if the anchoring process has not been completed (0 to disable)',
        default: 10
      }
    }
  }

  function getAnchorDelta(
    app,
    vesselPosition,
    positionArg,
    currentRadius,
    maxRadius,
    isSet,
    depth,
    rodeLength
  ) {
    var values

    if (vesselPosition == null) {
      vesselPosition = app.getSelfPath('navigation.position.value')
    }

    if (positionArg) {
      var position = {
        latitude: positionArg.latitude,
        longitude: positionArg.longitude
      }

      if (isSet) {
        if (!depth) {
          depth = app.getSelfPath('environment.depth.belowSurface.value')
        }
        app.debug('depth: %o', depth)
        if (typeof depth != 'undefined') {
          position.altitude = -1 * depth
        }
      } else {
        depth = state.position.altitude
        if (typeof depth != 'undefined') {
          position.altitude = depth
        }
      }

      values = [
        {
          path: 'navigation.anchor.position',
          value: position
        }
      ]

      let bowPosition = computeBowLocation(
        vesselPosition,
        app.getSelfPath('navigation.headingTrue.value')
      )
      let bearing = degsToRad(geolib.getRhumbLineBearing(bowPosition, position))
      let distanceFromBow = calc_distance(
        bowPosition.latitude,
        bowPosition.longitude,
        position.latitude,
        position.longitude
      )

      values.push({
        path: 'navigation.anchor.distanceFromBow',
        value: distanceFromBow
      })

      values.push({
        path: 'navigation.anchor.bearingTrue',
        value: bearing
      })

      if (rodeLength) {
        values.push({
          path: 'navigation.anchor.rodeLength',
          value: rodeLength
        })
      }

      if (currentRadius != null) {
        values.push({
          path: 'navigation.anchor.currentRadius',
          value: currentRadius
        })
      }

      if (maxRadius != null) {
        values.push({
          path: 'navigation.anchor.maxRadius',
          value: maxRadius
        })
        var zones
        if (configuration.warningPercentage) {
          let warning = maxRadius * (configuration.warningPercentage / 100)
          zones = [
            {
              state: 'normal',
              lower: 0,
              upper: warning
            },
            {
              state: 'warn',
              lower: warning,
              upper: maxRadius
            },
            {
              state: configuration.state,
              lower: maxRadius
            }
          ]
        } else {
          zones = [
            {
              state: 'normal',
              lower: 0,
              upper: maxRadius
            },
            {
              state: configuration.state,
              lower: maxRadius
            }
          ]
        }
        values.push({
          path: 'navigation.anchor.meta',
          value: {
            zones: zones
          }
        })
      }
      if (typeof configuration.bowHeight !== 'undefined') {
        values.push({
          path: 'design.bowAnchorHight', // Deprecated
          value: configuration.bowHeight
        })
        values.push({
          path: 'design.bowAnchorHeight',
          value: configuration.bowHeight
        })
      }
      if (typeof configuration.fudge !== 'undefined') {
        values.push({
          path: 'navigation.anchor.fudgeFactor',
          value: configuration.fudge
        })
      }
    } else {
      values = [
        {
          path: 'navigation.anchor.position',
          value: null //{ latitude: null, longitude: null, altitude: null }
        },
        {
          path: 'navigation.anchor.currentRadius',
          value: null
        },
        {
          path: 'navigation.anchor.maxRadius',
          value: null
        },
        {
          path: 'navigation.anchor.distanceFromBow',
          value: null
        },
        {
          path: 'navigation.anchor.rodeLength',
          value: null
        }
      ]
    }

    var delta = {
      updates: [
        {
          values: values
        }
      ]
    }

    //app.debug("anchor delta: " + util.inspect(delta, {showHidden: false, depth: 6}))
    return delta
  }

  function checkPosition(
    app,
    plugin,
    radius,
    position,
    anchor_position,
    rodeLength
  ) {
    app.debug("in checkPosition: " + position.latitude + ',' + anchor_position.latitude)

    if (
      !position?.latitude || !position?.longitude ||
      !anchor_position?.latitude || !anchor_position?.longitude) {
      return
    }

    let meters = calc_distance(
      position.latitude,
      position.longitude,
      anchor_position.latitude,
      anchor_position.longitude
    )

    app.debug('distance: ' + meters + ', radius: ' + radius)

    let delta = getAnchorDelta(
      app,
      position,
      anchor_position,
      meters,
      radius,
      false,
      null,
      rodeLength
    )
    app.handleMessage(plugin.id, delta)

    if (radius != null) {
      var alarmState
      var warning = configuration.warningPercentage
        ? (configuration.warningPercentage / 100) * radius
        : 0
      if (meters > radius) {
        alarmState = configuration.state
      } else if (
        warning > 0 &&
        configuration.warningNotification &&
        meters > warning
      ) {
        alarmState = 'warn'
      }

      if (alarmState) {
        if (!configuration.delay) {
          return alarmState
        } else {
          if (delayStartTime) {
            if ((Date.now() - delayStartTime) / 1000 > configuration.delay) {
              app.debug('alarm delay reached')
              return alarmState
            }
          } else {
            delayStartTime = Date.now()
            app.debug('delaying alarm for %d seconds', configuration.delay)
          }
        }
      } else if (delayStartTime) {
        delayStartTime = undefined
      }
    }

    return null
  }

  function computeBowLocation(position, heading) {
    if (typeof heading != 'undefined') {
      let gps_dist = app.getSelfPath('sensors.gps.fromBow.value')
      //app.debug('gps_dist: ' + gps_dist)
      if (typeof gps_dist != 'undefined') {
        position = calc_position_from(app, position, heading, gps_dist)
        //app.debug('adjusted position by ' + gps_dist)
      }
    }
    return position
  }

  function computeAnchorApparentBearing(
    vesselPosition,
    anchorPosition,
    trueHeading
  ) {
    if (
      !vesselPosition?.latitude || !vesselPosition?.longitude ||
      !anchorPosition?.latitude || !anchorPosition?.longitude ||
      typeof trueHeading === 'undefined'
    ) {
      return
    }

    let bowPosition = computeBowLocation(vesselPosition, trueHeading)
    let bearing = degsToRad(
      geolib.getRhumbLineBearing(bowPosition, anchorPosition)
    )

    /* there's got to be a better way?? */
    let offset
    if (bearing > Math.PI) {
      offset = Math.PI * 2 - bearing
    } else {
      offset = -bearing
    }

    let zeroed = trueHeading + offset
    let apparent
    if (zeroed < Math.PI) {
      apparent = -zeroed
    } else {
      apparent = zeroed
      if (apparent > Math.PI) {
        apparent = Math.PI * 2 - apparent
      }
    }

    /*
    app.debug(
      'apparent ' +
        radsToDeg(trueHeading) +
        ', ' +
        radsToDeg(bearing) +
        ', ' +
        apparent +
        ', ' +
        radsToDeg(apparent)
        )
        */

    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'navigation.anchor.apparentBearing',
              value: apparent
            }
          ]
        }
      ]
    })
  }

  function sendAnchorAlarm(alarmState, app, plugin, msg) {
    if (alarmState) {
      var delta = getAnchorAlarmDelta(app, alarmState, msg)
      app.debug('send alarm: %j', delta)
      app.handleMessage(plugin.id, delta)
    }
  }

  return plugin
}

function calc_distance(lat1, lon1, lat2, lon2) {
  return geolib.getDistance(
    { latitude: lat1, longitude: lon1 },
    { latitude: lat2, longitude: lon2 },
    0.1
  )
}

function calc_position_from(app, position, heading, distance) {
  return geolib.computeDestinationPoint(position, distance, radsToDeg(heading))
}

function getAnchorAlarmDelta(app, alarmState, msg) {
  if (!msg) {
    msg =
      'Anchor Alarm - ' +
      alarmState.charAt(0).toUpperCase() +
      alarmState.slice(1)
  }
  let method = ['visual', 'sound']
  const existing = app.getSelfPath('notifications.navigation.anchor.value')
  app.debug('existing %j', existing)
  if (existing && existing.state !== 'normal') {
    method = existing.method
  }
  var delta = {
    updates: [
      {
        values: [
          {
            path: 'notifications.navigation.anchor',
            value: {
              state: alarmState,
              method,
              message: msg
            }
          }
        ]
      }
    ]
  }
  return delta
}

function radsToDeg(radians) {
  return (radians * 180) / Math.PI
}

function degsToRad(degrees) {
  return degrees * (Math.PI / 180.0)
}
