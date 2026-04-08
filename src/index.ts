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

/// <reference types="node" />

import * as path from 'path'
import * as fs from 'fs'
import * as geolib from 'geolib'
import {
  Plugin,
  ServerAPI as PluginServerApp,
  Position,
  Delta,
  ActionResult,
  hasValues,
  SubscribeMessage,
  Path,
  Context,
  Unsubscribes,
  PathValue,
  Notification
} from '@signalk/server-api'

const subscribeperiod: number = 1000

// Plugin-specific interfaces
interface AnchorState {
  on: boolean
  position?: Position
  radius?: number
  rodeLength?: number
}

interface Configuration {
  delay?: number
  warningPercentage?: number
  warningNotification?: boolean
  noPositionAlarmTime?: number
  fudge?: number
  bowHeight?: number
  state?: string
  incompleteAnchorAlarmTime?: number
  enableRodeAutomation?: boolean
  rodeCounterPath?: string
  rodeThreshold?: number
  rodeStabilizationTime?: number
  useRodeCounterAsRadius?: boolean
  radius?: number
  on?: boolean
  position?: Position
}

interface PositionTrack {
  position: Position
  time: number
}

const load = function (app: PluginServerApp): Plugin {
  const plugin: Plugin = {} as Plugin
  let alarmSent: boolean = false
  let prevAnchorState: string | undefined
  let positionStop: Unsubscribes = []
  let rodeStop: Unsubscribes = []
  let positionInterval: NodeJS.Timeout | null = null
  let positionAlarmSent: boolean = false
  let configuration: Configuration = {}
  let delayStartTime: number | undefined
  let lastTrueHeading: number | undefined
  let lastPosition: Position | undefined
  let lastPositionTime: number | undefined
  let saveOptionsTimer: NodeJS.Timeout | undefined
  let track: PositionTrack[] = []
  let incompleteAnchorTimer: NodeJS.Timeout | undefined
  let sentIncompleteAnchorAlarm: boolean = false
  let statePath: string
  let state: AnchorState = { on: false }
  let lastRodeValue: number = 0
  let rodeAutomationEnabled: boolean = false
  let rodeStabilizationTimer: NodeJS.Timeout | null = null
  let anchoringInProgress: boolean = false
  let rodeStabilizationValue: number | null = null
  let rodeStabilizationStartTime: number | null = null

  plugin.start = function (props: Configuration): void | Error {
    configuration = props
    try {
      statePath = path.join(app.getDataDirPath(), 'state.json')

      if (fs.existsSync(statePath)) {
        let stateString: string
        try {
          stateString = fs.readFileSync(statePath, 'utf8')
        } catch (e) {
          app.error('Could not read state ' + statePath + ' - ' + e)
          return
        }
        try {
          state = JSON.parse(stateString) as AnchorState
        } catch (e) {
          app.error('Could not parse state ' + e)
          return
        }
      } else {
        state = { on: false }

        const isOn = configuration.on
        if (isOn) {
          state.on = isOn
          state.position = configuration.position
          state.radius = configuration.radius
          saveState()
        }
      }

      sendMeta()

      if (
        typeof state.on !== 'undefined' &&
        state.on &&
        typeof state.position !== 'undefined' &&
        typeof state.radius !== 'undefined'
      ) {
        startWatchingPosition()
      }

      // Initialize rode counter automation
      if (configuration.enableRodeAutomation && configuration.rodeCounterPath) {
        rodeAutomationEnabled = true
        lastRodeValue = app.getSelfPath(
          configuration.rodeCounterPath + '.value'
        ) as number
        app.debug('Rode automation enabled, current value: ' + lastRodeValue)
        startRodeCounterSubscription()
      }

      app.registerPutHandler(
        'vessels.self',
        'navigation.anchor.position',
        putPosition
      )

      app.registerPutHandler(
        'vessels.self',
        'navigation.anchor.maxRadius',
        putRadius
      )

      app.registerPutHandler(
        'vessels.self',
        'navigation.anchor.rodeLength',
        putRodeLength
      )

      sendMeta()
    } catch (e) {
      app.error('error: ' + e)
      console.error((e as Error).stack)
      return e as Error
    }
  }

  function sendMeta(): void {
    app.handleMessage(plugin.id, {
      updates: [
        {
          meta: [
            {
              path: 'navigation.anchor.bearingTrue' as any,
              value: { units: 'rad' }
            },
            {
              path: 'navigation.anchor.apparentBearing' as any,
              value: { units: 'rad' }
            },
            {
              path: 'navigation.anchor.rodeLength' as any,
              value: { units: 'm' }
            },
            {
              path: 'navigation.anchor.fudgeFactor' as any,
              value: { units: 'm' }
            },
            {
              path: 'navigation.anchor.distanceFromBow' as any,
              value: { units: 'm' }
            }
          ]
        }
      ]
    })
  }

  function saveState(): void {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    savePluginOptions()
  }

  function savePluginOptions(): void {
    if (!saveOptionsTimer) {
      saveOptionsTimer = setTimeout(() => {
        app.debug('saving options..')
        saveOptionsTimer = undefined
        app.savePluginOptions(
          configuration,
          (err: NodeJS.ErrnoException | null) => {
            if (err) {
              app.error(err.message)
            }
          }
        )
      }, 1000)
    }
  }

  function putRadius(
    context: string,
    path: string,
    value: unknown
  ): ActionResult {
    const radius = value as number
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'navigation.anchor.maxRadius' as any,
              value: radius
            }
          ]
        }
      ]
    })

    state.radius = radius
    configuration.radius = radius
    if (state.position) {
      state.on = true
      configuration.on = true
      startWatchingPosition()
    }

    try {
      saveState()
      return { state: 'COMPLETED' }
    } catch (err) {
      app.error((err as Error).message)
      return { state: 'FAILED', message: (err as Error).message }
    }
  }

  function putRodeLength(
    context: string,
    path: string,
    value: unknown
  ): ActionResult {
    const rodeLength = value as number
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'navigation.anchor.rodeLength' as any,
              value: rodeLength
            }
          ]
        }
      ]
    })

    const res = setManualAnchor(undefined, rodeLength)

    if (res.statusCode !== 200) {
      return { state: 'FAILED', message: res.message }
    } else {
      return { state: 'COMPLETED' }
    }
  }

  function putPosition(
    context: string,
    path: string,
    value: unknown
  ): ActionResult {
    const position = value as Position | null
    try {
      if (position === null) {
        raiseAnchor()
      } else {
        const delta = getAnchorDelta(
          undefined,
          value as Position,
          undefined,
          state.radius,
          true,
          undefined,
          state.rodeLength
        )
        app.handleMessage(plugin.id, delta)

        state.position = {
          latitude: position.latitude,
          longitude: position.longitude,
          altitude: position.altitude
        }

        if (state.radius) {
          state.on = true
          configuration.on = true
          startWatchingPosition()
        }

        saveState()
      }
      return { state: 'COMPLETED' }
    } catch (err) {
      app.error((err as Error).message)
      return { state: 'FAILED', message: (err as Error).message }
    }
  }

  plugin.stop = function (): void {
    if (alarmSent) {
      const alarmDelta = getAnchorAlarmDelta('normal')
      app.handleMessage(plugin.id, alarmDelta)
    }
    alarmSent = false
    const delta = getAnchorDelta(
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined
    )
    app.handleMessage(plugin.id, delta)
    stopWatchingPosition()
    stopRodeCounterSubscription()
  }

  function stopWatchingPosition(): void {
    positionStop.forEach((f) => f())
    positionStop = []
    track = []
    if (positionInterval) {
      clearInterval(positionInterval)
      positionInterval = null
    }
  }

  function startWatchingPosition(): void {
    if (positionStop.length > 0) return

    if (configuration.noPositionAlarmTime !== 0) {
      positionInterval = setInterval(() => {
        app.debug('checking last position...')
        if (
          !lastPositionTime ||
          Date.now() - lastPositionTime >
            (configuration.noPositionAlarmTime || 0) * 1000
        ) {
          positionAlarmSent = true
          sendAnchorAlarm(
            configuration.state || 'emergency',
            'No position received'
          )
        } else if (alarmSent === null && positionAlarmSent) {
          const delta = getAnchorAlarmDelta('normal')
          app.handleMessage(plugin.id, delta)
          positionAlarmSent = false
        }
      }, ((configuration.noPositionAlarmTime || 0) / 2.0) * 1000)
    }

    track = []
    const positionSubscription: SubscribeMessage = {
      context: 'vessels.self' as any,
      subscribe: [
        {
          path: 'navigation.position' as any,
          period: subscribeperiod
        },
        {
          path: 'navigation.headingTrue' as any,
          period: subscribeperiod
        }
      ]
    }

    app.subscriptionmanager.subscribe(
      positionSubscription,
      positionStop as any,
      (err: unknown) => {
        app.error('subscription error: ' + err)
        app.setPluginError('subscription error: '+ err)
      },
      (delta: Delta) => {
        let position: Position | undefined
        let trueHeading: number | undefined

        if (delta.updates) {
          delta.updates.forEach((update) => {
            if (hasValues(update)) {
              update.values.forEach((vp) => {
                if (vp.path === 'navigation.position') {
                  position = vp.value as Position
                  // Track the position. Only record the position every minute.
                  if (
                    track.length === 0 ||
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
                  trueHeading = vp.value as number
                }
              })
            }
          })
        }

        if (position) {
          lastPosition = position
          lastPositionTime = Date.now()
          const anchorState = checkPosition(
            state.radius || 0,
            position,
            state.position!,
            state.rodeLength
          )
          const wasSent = alarmSent
          alarmSent = anchorState !== undefined
          if (wasSent && !anchorState) {
            //clear it
            app.debug('clear_it')
            const anchorDelta = getAnchorAlarmDelta('normal')
            app.handleMessage(plugin.id, anchorDelta)
            delayStartTime = undefined
            alarmSent = false
          } else if (!wasSent || prevAnchorState !== anchorState) {
            sendAnchorAlarm(configuration.state || 'emergency')
          }
          prevAnchorState = anchorState
        }

        if (typeof trueHeading !== 'undefined' || position) {
          if (typeof trueHeading !== 'undefined') {
            lastTrueHeading = trueHeading
          }
          computeAnchorApparentBearing(
            lastPosition!,
            state.position!,
            lastTrueHeading
          )
        }
      }
    )
  }

  function startRodeCounterSubscription(): void {
    if (
      !rodeAutomationEnabled ||
      !configuration.rodeCounterPath ||
      rodeStop.length > 0
    ) {
      return
    }

    app.debug(
      'Starting rode counter subscription for path: ' +
        configuration.rodeCounterPath
    )

    const rodeSubscription: SubscribeMessage = {
      context: 'vessels.self' as any,
      subscribe: [
        {
          path: configuration.rodeCounterPath as any,
          period: subscribeperiod
        }
      ]
    }

    app.subscriptionmanager.subscribe(
      rodeSubscription,
      rodeStop as any,
      (err: unknown) => {
        app.error('Rode counter subscription error: ' + err)
      },
      (delta: Delta) => {
        if (delta.updates) {
          delta.updates.forEach((update) => {
            if (hasValues(update)) {
              update.values.forEach((vp) => {
                if (vp.path === configuration.rodeCounterPath) {
                  handleRodeCounterChange(vp.value as number)
                }
              })
            }
          })
        }
      }
    )
  }

  function stopRodeCounterSubscription(): void {
    rodeStop.forEach((f) => f())
    rodeStop = []
    clearRodeStabilizationTimer()
  }

  function clearRodeStabilizationTimer(): void {
    if (rodeStabilizationTimer) {
      clearTimeout(rodeStabilizationTimer)
      rodeStabilizationTimer = null
    }
    rodeStabilizationValue = null
    rodeStabilizationStartTime = null
  }

  function handleRodeCounterChange(rodeValue: number): void {
    if (!rodeAutomationEnabled || !configuration.rodeThreshold) {
      return
    }

    const threshold = configuration.rodeThreshold
    const wasDeployed = lastRodeValue >= threshold
    const isDeployed = rodeValue >= threshold

    app.debug(
      `Rode value changed: ${lastRodeValue} -> ${rodeValue}, threshold: ${threshold}`
    )

    if (!wasDeployed && isDeployed) {
      // Rode deployed beyond threshold - automatically set anchor position (but not radius yet)
      app.debug(
        'Rode deployed, automatically setting anchor position (waiting for stabilization)'
      )

      const res = dropAnchor(undefined)
      if (res) {
        app.error('Failed to drop anchor automatically: ' + res)
      } else {
        // Set anchoring in progress flag so stabilization logic will run
        anchoringInProgress = true
        app.debug('Anchor position set, starting stabilization monitoring')
      }
      saveState()
    } else if (wasDeployed && !isDeployed) {
      // Rode retrieved below threshold - automatically raise anchor
      app.debug('Rode retrieved, automatically raising anchor')
      clearRodeStabilizationTimer()
      anchoringInProgress = false
      raiseAnchor()
    } else if (isDeployed && anchoringInProgress) {
      // Rode is deployed and we're in anchoring process - check if it has stabilized
      const stabilizationThreshold = 0.1 // meters
      const stabilizationTime =
        (configuration.rodeStabilizationTime || 10) * 1000 // milliseconds

      if (rodeStabilizationValue === null) {
        // First time checking for stabilization, set reference value
        rodeStabilizationValue = rodeValue
        rodeStabilizationStartTime = Date.now()
        app.debug(
          `Starting rode stabilization tracking at ${rodeValue}m (timer: ${
            stabilizationTime / 1000
          }s)`
        )

        // Capture the value in closure to avoid reference issues
        const stabilizedValue = rodeStabilizationValue
        rodeStabilizationTimer = setTimeout(() => {
          app.debug(
            `Stabilization timer expired for value ${stabilizedValue}m, completing anchoring`
          )
          completeAnchoring(stabilizedValue)
        }, stabilizationTime)
      } else if (
        Math.abs(rodeValue - rodeStabilizationValue) <= stabilizationThreshold
      ) {
        // Value is still within stable range - check if enough time has passed
        if (rodeStabilizationStartTime) {
          const timeInStableRange = Date.now() - rodeStabilizationStartTime
          app.debug(
            `Rode stable at ${rodeValue}m for ${
              timeInStableRange / 1000
            }s (need ${stabilizationTime / 1000}s)`
          )

          // Timer is still running and will complete when time is reached
        }
      } else {
        // Rode moved outside stable range - reset stabilization tracking
        app.debug(
          `Rode moved outside stable range: ${rodeStabilizationValue} -> ${rodeValue}, restarting stabilization`
        )
        clearRodeStabilizationTimer()

        // Start new stabilization period with current value
        rodeStabilizationValue = rodeValue
        rodeStabilizationStartTime = Date.now()

        // Capture the value in closure to avoid reference issues
        const stabilizedValue = rodeStabilizationValue
        rodeStabilizationTimer = setTimeout(() => {
          app.debug(
            `Stabilization timer expired (after reset) for value ${stabilizedValue}m, completing anchoring`
          )
          completeAnchoring(stabilizedValue)
        }, stabilizationTime)
      }
    }

    lastRodeValue = rodeValue
  }

  function completeAnchoring(finalRodeLength: number): void {
    if (!anchoringInProgress || !state.position) {
      app.debug('completeAnchoring called but anchoring not in progress or no anchor position')
      return
    }

    app.debug('Completing anchoring process with rode length: ' + finalRodeLength + 'm')
    
    // Update the rode length to the final stabilized value
    //state.rodeLength = finalRodeLength
    
    // Call setRadius with undefined to auto-calculate based on current position
    let error = setRadius(undefined)
    if (error) {
      app.error('Failed to set radius automatically: ' + error)
      return
    }

    // Mark anchoring as complete
    anchoringInProgress = false

    // Clear incomplete anchor alarm since we've completed the process
    clearIncompleteAlarm()
    
    // Clear stabilization tracking
    clearRodeStabilizationTimer()
    
    saveState()
    app.debug('Anchoring process completed automatically with radius: ' + state.radius + 'm')
  }

  // Rest of the functions would continue here... (truncated for length)
  // I'll include the essential function stubs and schema

  function clearIncompleteAlarm(): void {
    app.debug('clearIncompleteAlarm')
    if (incompleteAnchorTimer) {
      clearTimeout(incompleteAnchorTimer)
      incompleteAnchorTimer = undefined
    }
    if (sentIncompleteAnchorAlarm) {
      sendAnchorAlarm('normal')
      sentIncompleteAnchorAlarm = false
    }
  }

  function raiseAnchor(): void {
    app.debug('raise anchor')

    const delta = getAnchorDelta(
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined
    )
    app.handleMessage(plugin.id, delta)

    clearIncompleteAlarm()
    clearRodeStabilizationTimer()
    anchoringInProgress = false

    if (alarmSent) {
      const alarmDelta = getAnchorAlarmDelta('normal')
      app.handleMessage(plugin.id, alarmDelta)
    }
    alarmSent = false
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
              path: 'navigation.anchor.apparentBearing' as Path,
              value: null
            },
            {
              path: 'navigation.anchor.bearingTrue' as Path,
              value: null
            }
          ]
        }
      ]
    })

    saveState()
  }

  function dropAnchor(radius?: number): string | undefined {
    let vesselPosition: any = app.getSelfPath('navigation.position')
    if (vesselPosition && vesselPosition.value)
      vesselPosition = vesselPosition.value

    if (typeof vesselPosition == 'undefined') {
      app.debug('no position available')

      return 'no position available'
    } else {
      const position = computeBowLocation(
        vesselPosition,
        app.getSelfPath('navigation.headingTrue.value') as number | undefined
      )

      app.debug(
        'set anchor position to: ' +
          position.latitude +
          ' ' +
          position.longitude
      )
      if (typeof radius == 'undefined') {
        radius = undefined
      }

      const depth = app.getSelfPath('environment.depth.belowSurface.value') as
        | number
        | undefined

      const delta = getAnchorDelta(
        vesselPosition,
        position,
        0,
        radius,
        true,
        depth,
        undefined
      )
      app.handleMessage(plugin.id, delta)

      sendAnchorAlarm('normal')

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
            'The anchoring process has not been completed'
          )
          sentIncompleteAnchorAlarm = true
          incompleteAnchorTimer = undefined
        }, alarmTime * 60 * 1000)
      }

      startWatchingPosition()

      return undefined
    }
  }

  function setRadius(radius?: number): string | undefined {
    const position = app.getSelfPath('navigation.position.value') as
      | Position
      | undefined
    if (position === undefined) {
      app.debug('no position available')
      return 'no position available'
    } else {
      if (state.position === undefined) {
        return 'the anchor has not been dropped'
      }

      clearIncompleteAlarm()

      if (radius === undefined) {
        app.debug('state: %o', state)
        if (configuration.useRodeCounterAsRadius) {
          radius = getAlarmRadiusFromRodeLength(
            state.position.altitude as number
          )
        } else {
          radius = calcDistance(
            state.position.latitude,
            state.position.longitude,
            position.latitude,
            position.longitude
          )
        }

        const fudge = configuration.fudge
        if (typeof fudge !== 'undefined' && fudge > 0) {
          radius += fudge
        }

        calculateRodeLength(position)

        app.debug('calc_distance: ' + radius)
      } else {
        radius = Number(radius)
      }

      app.debug('set anchor radius: ' + radius)

      const delta = getAnchorDelta(
        position,
        state.position,
        undefined,
        radius,
        false,
        state.position.altitude,
        state.rodeLength
      )
      app.handleMessage(plugin.id, delta)

      state.radius = radius
      configuration['radius'] = radius

      return undefined
    }
  }

  function calculateRodeLength(vesselPosition: Position): void {
    const heading = app.getSelfPath('navigation.headingTrue.value') as
      | number
      | undefined
    if (
      heading !== undefined &&
      state.position &&
      state.position.altitude !== undefined
    ) {
      const bowPosition = computeBowLocation(vesselPosition, heading)
      const distanceFromBow = calcDistance(
        bowPosition.latitude,
        bowPosition.longitude,
        state.position.latitude,
        state.position.longitude
      )

      const height = configuration.bowHeight || 0
      let heightFromBow = state.position.altitude * -1
      heightFromBow += height
      state.rodeLength = Math.sqrt(
        heightFromBow * heightFromBow + distanceFromBow * distanceFromBow
      )
    }
  }

  function getAlarmRadiusFromRodeLength(depth: number): number {
    const rode = app.getSelfPath(configuration.rodeCounterPath + '.value') as
      | number
      | undefined

    if (!rode) {
      app.debug('rode counter value not available')
      return 0
    }

    let maxRadius = rode

    if (depth !== undefined) {
      const height = configuration.bowHeight
      let heightFromBow = depth * -1
      if (typeof height !== 'undefined' && height > 0) {
        heightFromBow += height
      }

      maxRadius = Math.abs(rode * rode - heightFromBow * heightFromBow)
      maxRadius = Math.sqrt(maxRadius)
      if (typeof maxRadius !== 'number' || isNaN(maxRadius)) {
        app.debug('invalid maxRadius value calculated from rode length')
        return 0
      }
    }

    const gps_dist = app.getSelfPath('sensors.gps.fromBow.value') as
      | number
      | undefined
    if (gps_dist !== undefined) {
      maxRadius += gps_dist
    }

    return maxRadius
  }

  function setManualAnchor(depth?: number, rode?: number): ActionResult {
    const position = app.getSelfPath('navigation.position.value') as
      | Position
      | undefined
    if (!position) {
      app.debug('no position available')
      return {
        statusCode: 403,
        state: 'FAILED',
        message: 'no position available'
      }
    }

    let heading = app.getSelfPath('navigation.headingTrue.value') as
      | number
      | undefined

    if (typeof heading === 'undefined') {
      heading = app.getSelfPath('navigation.headingMagnetic.value') as
        | number
        | undefined
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
      const sd = app.getSelfPath('environment.depth.belowSurface.value')
      if (typeof sd === 'number' && !isNaN(sd)) {
        depth = sd
      } else {
        app.debug('no depth available')
        return {
          statusCode: 403,
          state: 'FAILED',
          message: 'no depth available'
        }
      }
    }

    if (depth !== 0 && rode !== 0) {
      const height = configuration.bowHeight
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

    const gps_dist = app.getSelfPath('sensors.gps.fromBow.value') as
      | number
      | undefined
    if (gps_dist !== undefined) {
      maxRadius += gps_dist
    }

    const curRadius = maxRadius
    const fudge = configuration.fudge
    if (typeof fudge !== 'undefined' && fudge > 0) {
      app.debug('fudge radius by ' + fudge)
      maxRadius += fudge
    }

    const newposition = calcPositionFrom(position, heading, curRadius)

    const delta = getAnchorDelta(
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
      app.error((err as Error).message)
      return {
        statusCode: 501,
        state: 'FAILED',
        message: (err as Error).message
      }
    }
  }

  function startWatchingPosistion() {
    if (positionStop.length > 0) return

    if (
      configuration.noPositionAlarmTime != 0 &&
      configuration.noPositionAlarmTime !== undefined
    ) {
      const noPositionAlarmTime: number = configuration.noPositionAlarmTime
      positionInterval = setInterval(() => {
        app.debug('checking last position...')
        if (
          !lastPositionTime ||
          Date.now() - lastPositionTime > noPositionAlarmTime * 1000
        ) {
          positionAlarmSent = true
          sendAnchorAlarm('alarm', 'No position received')
        } else if (alarmSent === false && positionAlarmSent) {
          const delta = getAnchorAlarmDelta('normal')
          app.handleMessage(plugin.id, delta)
          positionAlarmSent = false
        }
      }, (configuration.noPositionAlarmTime / 2.0) * 1000)
    }

    track = []
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self' as Context,
        subscribe: [
          {
            path: 'navigation.position' as Path,
            period: 1000
          },
          {
            path: 'navigation.headingTrue' as Path,
            period: 1000
          }
        ]
      },
      positionStop,
      (err) => {
        app.error(err as string)
        app.setPluginError(err as string)
      },
      (delta) => {
        let position, trueHeading

        if (delta.updates) {
          delta.updates.forEach((update) => {
            if (hasValues(update)) {
              update.values.forEach((vp) => {
                if (vp.path === 'navigation.position') {
                  position = vp.value
                  // Track the positon. Only record the position every minute.
                  if (
                    track.length == 0 ||
                    track[track.length - 1].time < Date.now() - 60 * 1000
                  ) {
                    track.push({
                      position: position as Position,
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
          lastPosition = position
          lastPositionTime = Date.now()
          const anchorState = checkPosition(
            state.radius as number,
            position,
            state.position as Position,
            state.rodeLength
          )
          const was_sent = alarmSent
          alarmSent = anchorState !== undefined
          if (was_sent && !anchorState) {
            //clear it
            app.debug('clear_it')
            const anchorDelta = getAnchorAlarmDelta('normal')
            app.handleMessage(plugin.id, anchorDelta)
            delayStartTime = undefined
            alarmSent = false
          } else if (!was_sent || prevAnchorState != anchorState) {
            sendAnchorAlarm(anchorState as string)
          }
          prevAnchorState = anchorState
        }

        if (typeof trueHeading !== 'undefined' || position) {
          if (typeof trueHeading !== 'undefined') {
            lastTrueHeading = trueHeading
          }
          computeAnchorApparentBearing(
            lastPosition as Position,
            state.position as Position,
            lastTrueHeading
          )
        }
      }
    )
  }

  function checkPosition(
    radius: number,
    position: Position,
    anchorPosition: Position,
    rodeLength?: number
  ): string | undefined {
    app.debug(
      'in checkPosition: ' + position.latitude + ',' + anchorPosition.latitude
    )

    if (
      !position?.latitude ||
      !position?.longitude ||
      !anchorPosition?.latitude ||
      !anchorPosition?.longitude
    ) {
      return
    }

    let meters

    if (
      configuration.useRodeCounterAsRadius &&
      (state.radius === undefined || state.radius === null)
    ) {
      // we are still letting the anchor out
      app.debug('Calculating distance using rode length as radius')
      meters = getAlarmRadiusFromRodeLength(anchorPosition.altitude as number)
    } else {
      meters = calcDistance(
        position.latitude,
        position.longitude,
        anchorPosition.latitude,
        anchorPosition.longitude
      )
    }

    app.debug('distance: ' + meters + ', radius: ' + radius)

    const delta = getAnchorDelta(
      position,
      anchorPosition,
      meters,
      radius,
      false,
      undefined,
      rodeLength
    )
    app.handleMessage(plugin.id, delta)

    if (radius != null) {
      let alarmState
      const warning = configuration.warningPercentage
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

    return undefined
  }

  function sendAnchorAlarm(state: string, message?: string): void {
    if (state) {
      const delta = getAnchorAlarmDelta(state, message)
      app.debug('send alarm: %j', delta)
      app.handleMessage(plugin.id, delta)
    }
  }

  function getAnchorDelta(
    vesselPosition: Position | undefined,
    positionArg: Position | undefined,
    currentRadius: number | undefined,
    maxRadius: number | undefined,
    isSet: boolean,
    depth: number | undefined,
    rodeLength: number | undefined
  ): Delta {
    let values: PathValue[]

    if (vesselPosition === undefined) {
      vesselPosition = app.getSelfPath('navigation.position.value') as Position
    }

    if (positionArg !== undefined) {
      const position: Position = {
        latitude: positionArg.latitude,
        longitude: positionArg.longitude
      }

      if (isSet) {
        if (depth === undefined) {
          depth = app.getSelfPath('environment.depth.belowSurface.value') as
            | number
            | undefined
        }
        app.debug('depth: %o', depth)
        if (depth !== undefined) {
          position.altitude = -1 * depth
        }
      } else {
        depth = (state.position as Position).altitude as number | undefined
        if (depth !== undefined) {
          position.altitude = depth
        }
      }

      values = [
        {
          path: 'navigation.anchor.position' as Path,
          value: position
        }
      ]

      const bowPosition = computeBowLocation(
        vesselPosition,
        app.getSelfPath('navigation.headingTrue.value') as number | undefined
      )
      const bearing = degsToRad(
        geolib.getRhumbLineBearing(bowPosition, position)
      )
      const distanceFromBow = calcDistance(
        bowPosition.latitude,
        bowPosition.longitude,
        position.latitude,
        position.longitude
      )

      values.push({
        path: 'navigation.anchor.distanceFromBow' as Path,
        value: distanceFromBow
      })

      values.push({
        path: 'navigation.anchor.bearingTrue' as Path,
        value: bearing
      })

      if (rodeLength) {
        values.push({
          path: 'navigation.anchor.rodeLength' as Path,
          value: rodeLength
        })
      }

      if (currentRadius != null) {
        values.push({
          path: 'navigation.anchor.currentRadius' as Path,
          value: currentRadius
        })
      }

      if (maxRadius != null) {
        values.push({
          path: 'navigation.anchor.maxRadius' as Path,
          value: maxRadius
        })
        let zones
        if (configuration.warningPercentage) {
          const warning = maxRadius * (configuration.warningPercentage / 100)
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
          path: 'navigation.anchor.meta' as Path,
          value: {
            zones: zones
          }
        })
      }
      if (typeof configuration.bowHeight !== 'undefined') {
        values.push({
          path: 'design.bowAnchorHight' as Path, // Deprecated
          value: configuration.bowHeight
        })
        values.push({
          path: 'design.bowAnchorHeight' as Path,
          value: configuration.bowHeight
        })
      }
      if (typeof configuration.fudge !== 'undefined') {
        values.push({
          path: 'navigation.anchor.fudgeFactor' as Path,
          value: configuration.fudge
        })
      }
    } else {
      values = [
        {
          path: 'navigation.anchor.position' as Path,
          value: null //{ latitude: null, longitude: null, altitude: null }
        },
        {
          path: 'navigation.anchor.currentRadius' as Path,
          value: null
        },
        {
          path: 'navigation.anchor.maxRadius' as Path,
          value: null
        },
        {
          path: 'navigation.anchor.distanceFromBow' as Path,
          value: null
        },
        {
          path: 'navigation.anchor.rodeLength' as Path,
          value: null
        }
      ]
    }

    return {
      updates: [
        {
          values: values
        }
      ]
    }
  }

  function getAnchorAlarmDelta(alarmState: string, msg?: string): Delta {
    if (!msg) {
      msg =
        'Anchor Alarm - ' +
        alarmState.charAt(0).toUpperCase() +
        alarmState.slice(1)
    }
    let method = ['visual', 'sound']
    const existing = app.getSelfPath(
      'notifications.navigation.anchor.value'
    ) as Notification | undefined
    app.debug('existing %j', existing)
    if (existing && existing.state !== 'normal') {
      method = existing.method
    }
    const delta: Delta = {
      updates: [
        {
          values: [
            {
              path: 'notifications.navigation.anchor' as Path,
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

  function computeAnchorApparentBearing(
    vesselPosition: Position,
    anchorPosition: Position,
    heading?: number
  ): void {
    if (
      !vesselPosition?.latitude ||
      !vesselPosition?.longitude ||
      !anchorPosition?.latitude ||
      !anchorPosition?.longitude ||
      heading === undefined
    ) {
      return
    }

    const bowPosition = computeBowLocation(vesselPosition, heading)
    const bearing = degsToRad(
      geolib.getRhumbLineBearing(bowPosition, anchorPosition)
    )

    /* there's got to be a better way?? */
    let offset
    if (bearing > Math.PI) {
      offset = Math.PI * 2 - bearing
    } else {
      offset = -bearing
    }

    const zeroed = heading + offset
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
        radsToDeg(heading) +
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
              path: 'navigation.anchor.apparentBearing' as Path,
              value: apparent
            }
          ]
        }
      ]
    })
  }

  function computeBowLocation(position: any, heading?: number): any {
    if (typeof heading != 'undefined') {
      const gps_dist = app.getSelfPath('sensors.gps.fromBow.value') as
        | number
        | undefined
      //app.debug('gps_dist: ' + gps_dist)
      if (typeof gps_dist != 'undefined') {
        position = calcPositionFrom(position, heading, gps_dist)
        //app.debug('adjusted position by ' + gps_dist)
      }
    }
    return position
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
          'Send a notification after the boat has been outside of the alarms radius for the given number of seconds (0 for immediate)',
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
          'When an anchor drift notification is sent, this wil be used as the notification state',
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
      },
      enableRodeAutomation: {
        type: 'boolean',
        title: 'Enable Rode Counter Automation',
        description:
          'Automatically control anchor alarm based on rode counter value',
        default: false
      },
      rodeCounterPath: {
        type: 'string',
        title: 'Rode Counter Signal K Path',
        description:
          'Signal K path for the rode counter value (e.g. "steering.rudderAngle" or custom path)',
        default: 'navigation.anchor.rodeCounterLength'
      },
      rodeThreshold: {
        type: 'number',
        title: 'Rode Deployment Threshold (m)',
        description:
          'Minimum rode length in meters to automatically enable anchor alarm',
        default: 5
      },
      rodeStabilizationTime: {
        type: 'number',
        title: 'Rode Stabilization Time (s)',
        description:
          'Time in seconds to wait after rode stops changing before completing anchoring process',
        default: 10
      },
      useRodeCounterAsRadius: {
        type: 'boolean',
        title: 'Use Rode Counter as Alarm Radius',
        description:
          'Use the rode counter value directly as the alarm radius instead of calculating based on geometry',
        default: false
      }
    }
  } as any // Cast to any due to schema typing limitations

  plugin.registerWithRouter = function (router: any): void {
    router.post('/dropAnchor', (req: any, res: any) => {
      const error = dropAnchor(req.body['radius'])
      if (error) {
        res.status(403)
        res.json({
          statusCode: 403,
          state: 'FAILED',
          message: error
        })
        return
      }

      try {
        saveState()
        res.json({
          statusCode: 200,
          state: 'COMPLETED'
        })
      } catch (err: any) {
        app.error(String(err))
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/setRadius', (req: any, res: any) => {
      const error = setRadius(req.body['radius'])

      if (error) {
        res.status(403)
        res.json({
          statusCode: 403,
          state: 'FAILED',
          message: error
        })
        return
      }

      try {
        saveState()
        res.json({
          statusCode: 200,
          state: 'COMPLETED'
        })
      } catch (err: any) {
        app.error(String(err))
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/setRodeLength', (req: any, res: any) => {
      clearIncompleteAlarm()
      const length = req.body['length']
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

      let maxRadius = length

      if (!depth) {
        const sd = app.getSelfPath('environment.depth.belowSurface.value')
        if (typeof sd != 'undefined') {
          depth = sd
        }
      }

      if (depth && length) {
        const height = configuration.bowHeight
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

      const gps_dist = app.getSelfPath('sensors.gps.fromBow.value')
      if (typeof gps_dist != 'undefined') {
        maxRadius += gps_dist
      }

      const fudge = configuration.fudge
      if (typeof fudge !== 'undefined' && fudge > 0) {
        app.debug('fudge radius by ' + fudge)
        maxRadius += fudge
      }

      app.debug('set anchor radius: ' + maxRadius)

      const delta = getAnchorDelta(
        undefined,
        state.position,
        undefined,
        maxRadius,
        false,
        undefined,
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
      } catch (err: any) {
        app.error(String(err))
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/raiseAnchor', (req: any, res: any) => {
      try {
        raiseAnchor()
        res.json({
          statusCode: 200,
          state: 'COMPLETED'
        })
      } catch (err: any) {
        app.error(String(err))
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/setAnchorPosition', (req: any, res: any) => {
      const old_pos = app.getSelfPath('navigation.anchor.position.value') as
        | Position
        | undefined
      let depth

      if (old_pos && old_pos.altitude) {
        depth = old_pos.altitude
      }

      const position = req.body['position']

      const maxRadius = app.getSelfPath('navigation.anchor.maxRadius.value') as
        | number
        | undefined

      const delta = getAnchorDelta(
        undefined,
        position,
        undefined,
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
      } catch (err: any) {
        app.error(String(err))
        res.status(500)
        res.json({
          statusCode: 500,
          state: 'FAILED',
          message: "can't save config"
        })
      }
    })

    router.post('/setManualAnchor', (req: any, res: any) => {
      app.debug('set manual anchor')
      const depth = req.body['anchorDepth']
      const rode = req.body['rodeLength']
      const result = setManualAnchor(depth, rode)
      res.status(result.statusCode).json(result)
    })

    router.get('/getTrack', (req: any, res: any) => {
      res.json(track)
    })
  }

  return plugin
}

function calcDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return geolib.getDistance(
    { latitude: lat1, longitude: lon1 },
    { latitude: lat2, longitude: lon2 },
    0.1
  )
}

function calcPositionFrom(position: any, heading: number, distance: number) {
  return geolib.computeDestinationPoint(position, distance, radsToDeg(heading))
}

function radsToDeg(radians: number): number {
  return (radians * 180) / Math.PI
}

function degsToRad(degrees: number): number {
  return degrees * (Math.PI / 180.0)
}

module.exports = load
export default load
