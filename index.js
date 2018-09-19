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

const Bacon = require('baconjs');
const _ = require('lodash')
const path = require('path')
const fs = require('fs')

module.exports = function(app) {
  var plugin = {};
  var alarm_sent = false
  var unsubscribe = undefined
  var state
  var configuration
  var delayStartTime 

  plugin.start = function(props) {
    configuration = props
    try {
      var isOn = configuration['on']
      var position = configuration['position']
      var radius = configuration['radius']
      if ( typeof isOn != 'undefined'
           && isOn
           && typeof position != 'undefined'
           && typeof radius != 'undefined' )
      {
        startWatchingPosistion()
      }

      if ( app.registerActionHandler ) {
        app.registerActionHandler('vessels.self',
                                  `navigation.anchor.position`,
                                  putPosition)

        app.registerActionHandler('vessels.self',
                                  `navigation.anchor.maxRadius`,
                                  putRadius)

        app.registerActionHandler('vessels.self',
                                  `navigation.anchor.rodeLength`,
                                  putRodeLength)
      }
      
    } catch (e) {
      plugin.started = false
      app.error("error: " + e);
      console.error(e.stack)
      return e
    }
  }

  function putRadius(context, path, value, cb) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: "navigation.anchor.maxRadius",
              value: value
            }
          ]
        }
      ]
    })

    configuration["radius"] = value
    if ( configuration["position"] ) {
      configuration["on"] = true
      if ( unsubscribe == null )
        startWatchingPosistion()
    }
    
    app.savePluginOptions(configuration, err => {
      if ( err ) {
        app.error(err.toString())
        cb({state: 'FAILURE', message: err.toString()})
      } else {
        cb({state: 'SUCCESS'})
      }
    })
    
    return { state: 'PENDING' }
  }

  function putRodeLength(context, path, value, cb) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: "navigation.anchor.rodeLength",
              value: value
            }
          ]
        }
      ]
    })

    setManualAnchor(null, value, (status, message) => {
      if ( status != 200 ) {
        cb({state: 'FAILURE', message})
      } else {
        app.savePluginOptions(configuration, err => {
          if ( err ) {
            app.error(err.toString())
            cb({state: 'FAILURE', message:err.toString()})
          } else {
            cb({state: 'SUCCESS'})
          }
        })
      }
    })
    
    return { state: 'PENDING' }
  }

  function putPosition(context, path, value, cb) {
    if ( value == null ) {
      raiseAnchor()
    } else {
      var delta = getAnchorDelta(app, value, null, configuration["radius"], true, null);
      app.handleMessage(plugin.id, delta)
      
      configuration["position"] = { "latitude": value.latitude,
                                    "longitude": value.longitude }
      //configuration["radius"] = value.radius
      if ( configuration["radius"] ) {
        configuration["on"] = true
        if ( unsubscribe == null )
          startWatchingPosistion()
      }
      
      app.savePluginOptions(configuration, err => {
        if ( err ) {
          app.error(err.toString())
          cb({state: 'FAILURE', message:err.toString()})
        } else {
          cb({state: 'SUCCESS'})
        }
      })
     
    }    
    return { state: 'PENDING' }
  }
    
  plugin.stop = function() {
    if ( alarm_sent )
    {
      var delta = getAnchorAlarmDelta(app, "normal")
      app.handleMessage(plugin.id, delta)
    }
    alarm_sent = false
    var delta = getAnchorDelta(app, null, null, null, false, null)
    app.handleMessage(plugin.id, delta)
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }

  function startWatchingPosistion()
  {
    unsubscribe = Bacon.combineWith(function(position) {
      var state
      state = checkPosition(app, plugin, configuration.radius,
                            position, configuration.position)
      var was_sent = alarm_sent
      alarm_sent = state
      if ( was_sent && !state )
      {
        //clear it
        app.debug("clear_it")
        var delta = getAnchorAlarmDelta(app, "normal")
        app.handleMessage(plugin.id, delta)
        delayStartTime = undefined
      }
      return state
    }, ['navigation.position' ].map(app.streambundle.getSelfStream, app.streambundle)).changes().debounceImmediate(1000).onValue(state => {
      sendAnchorAlarm(state, app, plugin)
    })
  }

  function raiseAnchor(cb) {
    app.debug("raise anchor")
    
    var delta = getAnchorDelta(app, null, null, null, false, null)
    app.handleMessage(plugin.id, delta)
    
    if ( alarm_sent )
    {
      var delta = getAnchorAlarmDelta(app, "normal")
      app.handleMessage(plugin.id, delta)
    }
    alarm_sent = false
    delayStartTime = undefined
    
    delete configuration["position"]
    delete configuration["radius"]
    configuration["on"] = false
    
    app.savePluginOptions(configuration, err => {
      if ( err ) {
        app.error(err.toString())
      }
      if ( cb ) {
        cb(err)
        }
    })
    if ( unsubscribe )
    {
      unsubscribe()
      unsubscribe = null
    }
  }


  plugin.registerWithRouter = function(router) {
    router.post("/dropAnchor", (req, res) => {
      var position = app.getSelfPath('navigation.position')
      if ( position && position.value )
        position = position.value
      
      if ( typeof position == 'undefined' )
      {
        app.debug("no position available")
        res.status(401)
        res.send("no position available")
      }
      else
      {

        var heading = app.getSelfPath('navigation.headingTrue.value')
        app.debug("heading: " + heading)
        if ( typeof heading != 'undefined' )
        {
          var gps_dist = app.getSelfPath("sensors.gps.fromBow.value");
          app.debug("gps_dist: " + gps_dist)
          if ( typeof gps_dist != 'undefined' )
          {
            position = calc_position_from(app, position, heading, gps_dist)
            app.debug("adjusted position by " + gps_dist)
          }
        }
  
        app.debug("set anchor position to: " + position.latitude + " " + position.longitude)
        var radius = req.body['radius']
        if ( typeof radius == 'undefined' )
          radius = null
        var delta = getAnchorDelta(app, position, 0, radius, true, null);
        app.handleMessage(plugin.id, delta)

        app.debug("anchor delta: " + JSON.stringify(delta))
        
        configuration["position"] = { "latitude": position.latitude,
                                      "longitude": position.longitude }
        configuration["radius"] = radius
        configuration["on"] = true

        var depth = app.getSelfPath('environment.depth.belowSurface.value')
        if ( depth ) {
          configuration.position.altitude = depth * -1;
        }
        
        app.savePluginOptions(configuration, err => {
          if ( err ) {
            app.error(err.toString())
            res.status(500)
            res.send("can't save config")
          } else {
            res.send('ok')
          }
        })
        if ( unsubscribe == null )
          startWatchingPosistion()
      }
    })
    
    router.post("/setRadius", (req, res) => {
      position = app.getSelfPath('navigation.position')
      if ( position.value )
        position = position.value
      if ( typeof position == 'undefined' )
      {
        app.debug("no position available")
        res.status(401)
        res.send("no position available")
      }
      else
      {
        var radius = req.body['radius']
        if ( typeof radius == 'undefined' )
        {
          app.debug("config: %o", configuration)
          radius = calc_distance(configuration.position.latitude,
                                 configuration.position.longitude,
                                 position.latitude,
                                 position.longitude)
          
          var fudge = configuration.fudge
          if ( typeof fudge !== 'undefined' && fudge > 0 )
          {
            radius += fudge
          }
          app.debug("calc_distance: " + radius)
        }

        app.debug("set anchor radius: " + radius)

        var delta = getAnchorDelta(app, configuration.position, radius,
                                   radius, false, null);
        app.handleMessage(plugin.id, delta)
        
        configuration["radius"] = radius
        
        app.savePluginOptions(configuration, err => {
          if ( err ) {
            app.error(err.toString())
            res.status(500)
            res.send("can't save config")
          } else {
            res.send('ok')
          }
        })
      }
    })

    router.post("/raiseAnchor", (req, res) => {
      raiseAnchor((err) => {
        if ( err ) {
          res.status(500)
          res.send("can't save config")
        } else {
          res.send('ok')
        }
      })
    })

    router.post("/setAnchorPosition", (req, res) => {
      var position = req.body['position']

      var maxRadius = app.getSelfPath('navigation.anchor.maxRadius.value')

      var delta = getAnchorDelta(app, position, null,
                                 maxRadius, false);

      app.debug("setAnchorPosition: " + JSON.stringify(delta))
      app.handleMessage(plugin.id, delta)

      configuration["position"] = { "latitude": position.latitude,
                                    "longitude": position.longitude }
      
      app.savePluginOptions(configuration, err => {
          if ( err ) {
            app.error(err.toString())
            res.status(500)
            res.send("can't save config")
          } else {
            res.send('ok')
          }
        })
    });

    router.post("/setManualAnchor", (req, res) => {
      app.debug("set manual anchor")
      var depth = req.body['anchorDepth']
      var rode = req.body['rodeLength']
      var result = setManualAnchor(depth, rode, (status, message) => {
        res.status(status)
        res.send(message)
      })
    })

    
  }

  function setManualAnchor(depth, rode, cb) {
      var position = app.getSelfPath('navigation.position')
      if ( position.value )
        position = position.value
      if ( typeof position == 'undefined' )
      {
        app.debug("no position available")
        cb(401, "no position available")
        return
      }

      var heading = app.getSelfPath('navigation.headingTrue.value')
     
      if ( typeof heading == 'undefined' )
      {
        heading = app.getSelfPath('navigation.headingMagnetic.value')
        if ( typeof heading == 'undefined' )
        {
          cb(401, "no heading available")
        }
      }
      
      app.debug("anchor rode: " + rode + " depth: " + depth)

      var maxRadius = rode;

      if ( depth == 0 )
      {
        var sd = app.getSelfPath('environment.depth.belowSurface.value')
        if ( typeof sd != 'undefined' )
        {
          depth = sd
        }
      }

      if ( depth != 0 && rode != 0 )
      {
        var height = configuration.bowHeight;
        var heightFromBow = depth
        if ( typeof height !== 'undefined' && height > 0 )
        {
          heightFromBow += height
        }
        //maxRadius = (depth * depth) + (rode * rode)
        maxRadius = (rode * rode) - (heightFromBow *heightFromBow)
        maxRadius = Math.sqrt(maxRadius)
      }

      app.debug("depth: " + depth)      
      app.debug("heading: " + heading)
      app.debug("maxRadius: " + maxRadius)

      var gps_dist = app.getSelfPath("sensors.gps.fromBow.value");
      if ( typeof gps_dist != 'undefined' )
      {
        maxRadius += gps_dist
      }

      var curRadius = maxRadius
      var fudge = configuration['fudge']
      if ( typeof fudge !== 'undefined' && fudge > 0 )
      {
        app.debug("fudge radius by " + fudge)
        maxRadius += fudge
      }

      var newposition = calc_position_from(app, position, heading, curRadius)

      var delta = getAnchorDelta(app, newposition, curRadius,
                                 maxRadius, true, depth);
      app.handleMessage(plugin.id, delta)
      
      delete configuration["position"]
      configuration["on"] = true
      configuration["radius"] = maxRadius
      configuration["position"] = newposition
      configuration["rodeLength"] = newposition
      if ( rode ) {
        configuration["rodeLength"] = rode
      }

      if ( depth ) {
        configuration.position.altitude = depth * -1
      }
        
      app.savePluginOptions(configuration, err => {
          if ( err ) {
            app.error(err.toString())
            cb(500, "can't save config")
          } else {
            cb(200, "ok")
          }
      })
      
      if ( unsubscribe == null )
        startWatchingPosistion()
    }
    
  plugin.id = "anchoralarm"
  plugin.name = "Anchor Alarm"
  plugin.description = "Plugin that checks the vessel position to see if there's anchor drift"

  plugin.schema = {
    title: "Anchor Alarm",
    type: "object",
    required: [
      "radius",
      "active",
    ],
    properties: {
      on: {
        type: 'boolean',
        title: 'Alarm On',
        default: false
      },
      radius: {
        type: "number",
        title: "Alarm Radius (m)",
        default: 60
      },
      delay: {
        type: "number",
        title: "Send an alarm after the bout has been outside of the alarms radius for the given time. (seconds, 0 for none)",
        default: 0
      },
      warningPercentage: {
        type: "number",
        title: "Percentage of alarm radius to set a warning (0 for none)",
        default: 0
      },
      warningNotification: {
        type: "boolean",
        title: "Send a notification when past the warning percentage",
        default: false
      },
      position: {
        type: "object",
        title: "Anchor Position",
        properties: {
          latitude: {
            title: "Latitude",
            type: "number"
          },
          longitude: {
            title: "Longitude",
            type: "number"
          },
          altitude: {
            title: "Altitude",
            type: "number"
          }
        }
      },
      fudge: {
        type: "number",
        title: "Alarm Radius Fudge Factor (m)",
        description: "When setting an automatic alarm, this will be added to the alarm radius to handle gps accuracy or a slightly off anchor position",
        default: 0
      },
      bowHeight: {
        type: "number",
        title: "The height of the bow from the water (m)",
        description: "This is used to calculate rode length",
        default: 0
      },
      state: {
        title: "State",
        description: "When an anchor drift notifcation is sent, this wil be used as the notitication state",
        type: "string",
        default: "emergency",
        "enum": ["alert", "warn", "alarm", "emergency"]
      }      
    }
  }

  function getAnchorDelta(app, position,
                          currentRadius, maxRadius, isSet, depth)
  {
    var values

    if ( position )
    {
      var position = {
        "latitude": position.latitude,
        "longitude": position.longitude
      };
      
      if ( isSet )
      {
        if ( !depth )
        {
          depth = app.getSelfPath('environment.depth.belowSurface.value')
        }
        app.debug("depth: %o", depth)
        if ( typeof depth != 'undefined' )
        {
          position.altitude = -1 * depth
        }
      }
      else
      {
        var depth = configuration.position.altitude
            //_.get(app.signalk.self,
	//	          'navigation.anchor.position.altitude')
        if ( typeof depth != 'undefined' )
        {
          position.altitude = depth
        }
      }  
      
      values = [
        {
          path: "navigation.anchor.position",
          value: position
        }
        /*
          {
          path: 'navigation.anchor.state',
          value: 'on'
          }
        */
      ]

      if ( currentRadius != null ) {
        values.push(        {
          path: 'navigation.anchor.currentRadius',
          value: currentRadius
        })
      }

      if ( maxRadius != null ) {
        values.push({
          path: 'navigation.anchor.maxRadius',
          value: maxRadius
        })
        var zones
        if ( configuration.warningPercentage ) {
          let warning = maxRadius * (configuration.warningPercentage/100)
          zones = [
            {
              state: "normal",
              lower: 0,
              upper: warning
            },
            {
              state: "warn",
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
              state: "normal",
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
      if ( typeof configuration.bowHeight !== 'undefined' ) {
        values.push({
          path: 'design.bowAnchorHight',
          value: configuration.bowHeight});
      }
      if ( typeof configuration.fudge !== 'undefined' ) {
        values.push({
          path: 'navigation.anchor.fudgeFactor',
          value: configuration.fudge});
      }
    }
    else
    {
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
        /*
          {
          path: 'navigation.anchor.state',
          value: 'off'
          }
        */
      ]
    }

    var delta = {
      "updates": [
        {
          "source": {
            "label": "anchoralarm"
          },
          "values": values
        }
      ]
    }

    //app.debug("anchor delta: " + util.inspect(delta, {showHidden: false, depth: 6}))
    return delta;
  }


  function checkPosition(app, plugin, radius, possition, anchor_position) {
    //app.debug("in checkPosition: " + possition.latitude + ',' + anchor_position.latitude)

    var meters = calc_distance(possition.latitude, possition.longitude,
                               anchor_position.latitude, anchor_position.longitude);
    
    app.debug("distance: " + meters + ", radius: " + radius);
    
    var delta = getAnchorDelta(app, anchor_position, meters, radius, false)
    app.handleMessage(plugin.id, delta)

    if ( radius != null ) {
      var state
      var warning = configuration.warningPercentage ? (configuration.warningPercentage/100) * radius : 0
      if ( meters > radius ) {
        state = configuration.state
      } else if ( warning > 0 && configuration.warningNotification && meters > warning ) {
        state = 'warn'
      }

      if ( state ) {
        if ( !configuration.delay ) {
          return state
        } else {
          if ( delayStartTime ) {
            if ( (Date.now() - delayStartTime)/1000 > configuration.delay ) {
              app.debug('alarm delay reached')
              return state
            }
          } else {
            delayStartTime = Date.now()
            app.debug('delaying alarm for %d seconds', configuration.delay)
          }
        }
      } else if ( delayStartTime ) {
        delayStartTime = undefined
      }
    }
  
    return null
  }

  function sendAnchorAlarm(state, app, plugin)
  {
    if ( state )
    {
      var delta = getAnchorAlarmDelta(app, state)
      app.debug("send alarm: %j", delta)
      app.handleMessage(plugin.id, delta)
    }
  }


   
  return plugin;
}

function calc_distance(lat1,lon1,lat2,lon2) {
  //app.debug("calc_distance: " + lat1 + ", " + lon1 + ", " + lat2 + ", " + lon2)
  var R = 6371000; // Radius of the earth in m
  var dLat = degsToRad(lat2-lat1);  // deg2rad below
  var dLon = degsToRad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(degsToRad(lat1)) * Math.cos(degsToRad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; // Distance in m
  return d;
}

function calc_position_from(app, position, heading, distance)
{
  var dist = (distance / 1000) / 1.852  //m to nm
  dist /= (180*60/Math.PI)  // in radians

  app.debug("dist: " + dist)
  
  heading = (Math.PI*2)-heading
  
  var lat = Math.asin(Math.sin(degsToRad(position.latitude)) * Math.cos(dist) + Math.cos(degsToRad(position.latitude)) * Math.sin(dist) * Math.cos(heading))
  
  var dlon = Math.atan2(Math.sin(heading) * Math.sin(dist) * Math.cos(degsToRad(position.latitude)), Math.cos(dist) - Math.sin(degsToRad(position.latitude)) * Math.sin(lat))
  
  var lon = mod(degsToRad(position.longitude) - dlon + Math.PI, 2 * Math.PI) - Math.PI
  
  return { "latitude": radsToDeg(lat),
           "longitude": radsToDeg(lon) }
}
  
function getAnchorAlarmDelta(app, state)
{
  var delta = {
      "updates": [
        {
          "values": [
            {
              "path": "notifications.navigation.anchor",
              "value": {
                "state": state,
                "method": [ "visual", "sound" ],
                "message": "Anchor Alarm - " + state.charAt(0).toUpperCase() + state.slice(1),
              }
            }]
        }
      ]
  }
  return delta;
}

function radsToDeg(radians) {
  return radians * 180 / Math.PI
}

function degsToRad(degrees) {
  return degrees * (Math.PI/180.0);
}

function mod(x,y){
  return x-y*Math.floor(x/y)
}

function mpsToKn(mps) {
  return 1.9438444924574 * mps
}


