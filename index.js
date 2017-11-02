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

const debug = require('debug')('anchoralarm')
const Bacon = require('baconjs');
const util = require('util')
const _ = require('lodash')
const path = require('path')
const fs = require('fs')

module.exports = function(app) {
  var plugin = {};
  var alarm_sent = false
  var unsubscribe = undefined
  var state
  var configuration

  plugin.start = function(props) {
    debug("starting with config: " + util.inspect(props, {showHidden: false, depth: 6}))
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
      
    } catch (e) {
      plugin.started = false
      debug("error: " + e);
      console.log(e.stack)
      return e
    }
    debug("started")
  }

  plugin.stop = function() {
    debug("stopping: alarm_sent: " + alarm_sent)
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
    debug("stopped")
  }

  function startWatchingPosistion()
  {
    unsubscribe = Bacon.combineWith(function(position) {
      var res = false
      res = checkPosition(app, plugin, configuration.radius,
                          position, configuration.position)
      var was_sent = alarm_sent
      alarm_sent = res
      if ( was_sent && !res )
      {
        //clear it
        debug("clear_it")
        var delta = getAnchorAlarmDelta(app, "normal")
        app.handleMessage(plugin.id, delta)
      }
      return res && !was_sent
    }, ['navigation.position' ].map(app.streambundle.getSelfStream, app.streambundle)).changes().debounceImmediate(1000).onValue(sendit => {
      sendAnchorAlarm(sendit,app, plugin, configuration.state)
    })
  }

  plugin.registerWithRouter = function(router) {
    router.post("/dropAnchor", (req, res) => {
      var position = _.get(app.signalk.self, 'navigation.position')
      if ( position.value )
        position = position.value
      
      if ( typeof position == 'undefined' )
      {
        debug("no position available")
        res.status(401)
        res.send("no position available")
      }
      else
      {

        var heading = _.get(app.signalk.self, 'navigation.headingTrue.value')
        debug("heading: " + heading)
        if ( typeof heading != 'undefined' )
        {
          var gps_dist = _.get(app.signalk.self, "sensors.gps.fromBow.value");
          debug("gps_dist: " + gps_dist)
          if ( typeof gps_dist != 'undefined' )
          {
            position = calc_position_from(position, heading, gps_dist)
            debug("adjusted position by " + gps_dist)
          }
        }
  
        debug("set anchor position to: " + position.latitude + " " + position.longitude)
        var radius = req.body['radius']
        if ( typeof radius == 'undefined' )
          radius = null
        var delta = getAnchorDelta(app, position, 0, radius, true, null);
        app.handleMessage(plugin.id, delta)
        
        var config = readJson(app, plugin.id)
        debug("config: " + util.inspect(config, {showHidden: false, depth: 6}))
        configuration = config["configuration"]

        configuration["position"] = { "latitude": position.latitude,
                                      "longitude": position.longitude }
        configuration["radius"] = radius
        configuration["on"] = true

        var depth = _.get(app.signalk.self,
		          'environment.depth.belowSurface.value')
        if ( depth ) {
          configuration.position.altitude = depth * -1;
        }
        
        saveJson(app, plugin.id, config, res)
        if ( unsubscribe == null )
          startWatchingPosistion()
      }
    })
    
    router.post("/setRadius", (req, res) => {
      position = _.get(app.signalk.self, 'navigation.position')
      if ( position.value )
        position = position.value
      if ( typeof position == 'undefined' )
      {
        debug("no position available")
        res.status(401)
        res.send("no position available")
      }
      else
      {
        var radius = req.body['radius']
        if ( typeof radius == 'undefined' )
        {
          debug("config: " + util.inspect(configuration, {showHidden: false, depth: 6}))
          radius = calc_distance(configuration.position.latitude,
                                 configuration.position.longitude,
                                 position.latitude,
                                 position.longitude)
          
          var fudge = configuration.fudge
          if ( typeof fudge !== 'undefined' && fudge > 0 )
          {
            radius += fudge
          }
          debug("calc_distance: " + radius)
        }

        debug("set anchor radius: " + radius)

        var delta = getAnchorDelta(app, configuration.position, radius,
                                   radius, false, null);
        app.handleMessage(plugin.id, delta)
        
        var config = readJson(app, plugin.id)
        configuration = config["configuration"]

        configuration["radius"] = radius
        
        saveJson(app, plugin.id, config, res)
      }
    })

    router.post("/raiseAnchor", (req, res) => {
      debug("raise anchor")
      
      var delta = getAnchorDelta(app, null, null, null, false, null)
      app.handleMessage(plugin.id, delta)

      if ( alarm_sent )
      {
        var delta = getAnchorAlarmDelta(app, "normal")
        app.handleMessage(plugin.id, delta)
      }
      alarm_sent = false
      
      var config = readJson(app, plugin.id)
      configuration = config["configuration"]
      
      delete configuration["position"]
      configuration["on"] = false
        
      saveJson(app, plugin.id, config, res)
      if ( unsubscribe )
      {
        unsubscribe()
        unsubscribe = null
      }
    })

    router.post("/setAnchorPosition", (req, res) => {
      var position = req.body['position']

      var maxRadius = _.get(app.signalk.self, 'navigation.anchor.maxRadius.value')

      var delta = getAnchorDelta(app, position, null,
                                 maxRadius, false);

      debug("setAnchorPosition: " + JSON.stringify(delta))
      app.handleMessage(plugin.id, delta)

      var config = readJson(app, plugin.id)
      configuration = config["configuration"]
      
      configuration["position"] = { "latitude": position.latitude,
                                    "longitude": position.longitude }
      
      saveJson(app, plugin.id, config, res)
    });

    router.post("/setManualAnchor", (req, res) => {
      debug("set manual anchor")

      var position = _.get(app.signalk.self, 'navigation.position')
      if ( position.value )
        position = position.value
      if ( typeof position == 'undefined' )
      {
        debug("no position available")
        res.status(401)
        res.send("no position available")
        return;
      }

      var heading = _.get(app.signalk.self, 'navigation.headingTrue.value')
     
      if ( typeof heading == 'undefined' )
      {
        heading = _.get(app.signalk.self, 'navigation.headingMagnetic.value')
        if ( typeof heading == 'undefined' )
        {
          debug("no heading available")
          res.status(401)
          res.send("no heading available")
          return;
        }
      }
      
      var depth = req.body['anchorDepth']
      var rode = req.body['rodeLength']

      debug("anchor rode: " + rode + " depth: " + depth)

      var maxRadius = rode;

      if ( depth == 0 )
      {
        var sd = _.get(app.signalk.self,
		       'environment.depth.belowSurface.value')
        if ( typeof sd != 'undefined' )
        {
          depth = sd
        }
      }

      if ( depth != 0 )
      {
        var height = configuration.bowHeight;
        var heightFromBow = depth
        if ( typeof height !== 'undefined' && height > 0 )
        {
          heightFromBow += height
        }
        //maxRadius = (depth * depth) + (rode * rode)
        maxRadius = (rode * rode) - (height *height)
        maxRadius = Math.sqrt(maxRadius)
      }

      debug("depth: " + depth)      
      debug("heading: " + heading)
      debug("maxRadius: " + maxRadius)

      var gps_dist = _.get(app.signalk.self, "sensors.gps.fromBow.value");
      if ( typeof gps_dist != 'undefined' )
      {
        maxRadius += gps_dist
      }

      var curRadius = maxRadius
      var fudge = configuration['fudge']
      if ( typeof fudge !== 'undefined' && fudge > 0 )
      {
        debug("fudge radius by " + fudge)
        maxRadius += fudge
      }

      var newposition = calc_position_from(position, heading, curRadius)

      var delta = getAnchorDelta(app, newposition, curRadius,
                                 maxRadius, true, depth);
      app.handleMessage(plugin.id, delta)
      
      var config = readJson(app, plugin.id)
      configuration = config["configuration"]
      
      delete configuration["position"]
      configuration["on"] = true
      configuration["radius"] = maxRadius
      configuration["position"] = newposition

      if ( depth ) {
        configuration.position.altitude = depth * -1
      }
        
      saveJson(app, plugin.id, config, res)
      if ( unsubscribe == null )
        startWatchingPosistion()

    })
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
          depth = _.get(app.signalk.self,
		        'environment.depth.belowSurface.value')
        }
        debug("depth: " + util.inspect(depth, {showHidden: false, depth: 6}))
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
        },
        {
          path: 'navigation.anchor.currentRadius',
          value: currentRadius
        }
        /*
          {
          path: 'navigation.anchor.state',
          value: 'on'
          }
        */
      ]
      if ( maxRadius != null ) {
        values.push({
          path: 'navigation.anchor.maxRadius',
          value: maxRadius
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
          value: { latitude: null, longitude: null, altitude: null }
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
      "context": "vessels." + app.selfId,
      "updates": [
        {
          "source": {
            "label": "anchoralarm"
          },
          "timestamp": (new Date()).toISOString(),
          "values": values
        }
      ]
    }

    //debug("anchor delta: " + util.inspect(delta, {showHidden: false, depth: 6}))
    return delta;
  }


  function checkPosition(app, plugin, radius, possition, anchor_position) {
    //debug("in checkPosition: " + possition.latitude + ',' + anchor_position.latitude)

    var meters = calc_distance(possition.latitude, possition.longitude,
                               anchor_position.latitude, anchor_position.longitude);
    
    debug("distance: " + meters + ", radius: " + radius);
    
    var delta = getAnchorDelta(app, anchor_position, meters, radius, false)
    app.handleMessage(plugin.id, delta)
  
    return radius != null &&  meters > radius;
  }

   
  return plugin;
}

function calc_distance(lat1,lon1,lat2,lon2) {
  //debug("calc_distance: " + lat1 + ", " + lon1 + ", " + lat2 + ", " + lon2)
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

function calc_position_from(position, heading, distance)
{
  var dist = (distance / 1000) / 1.852  //m to nm
  dist /= (180*60/Math.PI)  // in radians

  debug("dist: " + dist)
  
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
      "context": "vessels." + app.selfId,
      "updates": [
        {
          "source": {
            "label": "anchoralarm"
          },
          "timestamp": (new Date()).toISOString(),
          "values": [
            {
              "path": "notifications.anchorAlarm",
              "value": {
                "state": state,
                "method": [ "visual", "sound" ],
                "message": "Anchor Alarm - " + state.charAt(0).toUpperCase() + state.slice(1),
                "timestamp": (new Date()).toISOString()
              }
            }]
        }
      ]
  }
  return delta;
}

function sendAnchorAlarm(sendit, app, plugin, state)
{
  if ( sendit )
  {
    var delta = getAnchorAlarmDelta(app, state)
    debug("send alarm: " + util.inspect(delta, {showHidden: false, depth: 6}))
    app.handleMessage(plugin.id, delta)
  }
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

function pathForPluginId(app, id) {
    var dir = app.config.configPath || app.config.appPath
  return path.join(dir, "/plugin-config-data", id + '.json')
}

function readJson(app, id) {
  try
  {
    const path = pathForPluginId(app, id)
    debug("path: " + path)
    const optionsAsString = fs.readFileSync(path, 'utf8');
    try {
      return JSON.parse(optionsAsString)
    } catch (e) {
      console.error("Could not parse JSON options:" + optionsAsString);
      return {}
    }
  } catch (e) {
    debug("Could not find options for plugin " + id + ", returning empty options")
    debug(e.stack)
    return {}
  }
  return JSON.parse()
}

function saveJson(app, id, json, res)
{
  fs.writeFile(pathForPluginId(app, id), JSON.stringify(json, null, 2),
               function(err) {
                 if (err) {
                   debug(err.stack)
                   console.log(err)
                   res.status(500)
                   res.send(err)
                   return
                 }
                 else
                 {
                   res.send("Success\n")
                 }
               });
}
