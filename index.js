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
      app.signalk.addDelta(delta)
    }
    alarm_sent = false
    var delta = getAnchorDelta(app, null, null, null)
    app.signalk.addDelta(delta)
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
      res = checkPosition(app, configuration.radius,
                          position, configuration.position)
      var was_sent = alarm_sent
      alarm_sent = res
      if ( was_sent && !res )
      {
        //clear it
        debug("clear_it")
        var delta = getAnchorAlarmDelta(app, "normal")
        app.signalk.addDelta(delta)
      }
      return res && !was_sent
    }, ['navigation.position' ].map(app.streambundle.getSelfStream, app.streambundle)).changes().debounceImmediate(1000).onValue(sendit => {
      sendAnchorAlarm(sendit,app, configuration.state)
    })
  }

  plugin.registerWithRouter = function(router) {
    router.post("/dropAnchor", (req, res) => {
      position = _.get(app.signalk.self, 'navigation.position')
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
          var gps_dist = _.get(app.signalk.self, "design.gpsDistaneFromAnchorDrop");
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
        var delta = getAnchorDelta(app, position, 0, radius, true);
        app.signalk.addDelta(delta)
        
        var config = readJson(app, plugin.id)
        debug("config: " + util.inspect(config, {showHidden: false, depth: 6}))
        configuration = config["configuration"]

        configuration["position"] = { "latitude": position.latitude,
                                      "longitude": position.longitude }
        configuration["radius"] = radius
        configuration["on"] = true
        
        saveJson(app, plugin.id, config, res)
        if ( unsubscribe == null )
          startWatchingPosistion()
      }
    })
    
    router.post("/setRadius", (req, res) => {
      position = _.get(app.signalk.self, 'navigation.position')
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
          debug("calc_distance: " + radius)
        }

        debug("set anchor radius: " + radius)

        var delta = getAnchorDelta(app, configuration.position, radius,
                                   radius, false);
        app.signalk.addDelta(delta)
        
        var config = readJson(app, plugin.id)
        configuration = config["configuration"]

        configuration["radius"] = radius
        
        saveJson(app, plugin.id, config, res)
      }
    })

    router.post("/raiseAnchor", (req, res) => {
      debug("raise anchor")
      
      var delta = getAnchorDelta(app, null, null, null)
      app.signalk.addDelta(delta)

      if ( alarm_sent )
      {
        var delta = getAnchorAlarmDelta(app, "normal")
        app.signalk.addDelta(delta)
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

    router.post("/setManualAnchor", (req, res) => {
      debug("set manual anchor")

      position = _.get(app.signalk.self, 'navigation.position')
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

      var maxRadius = (depth * depth) + (rode * rode)
      maxRadius = Math.sqrt(maxRadius)

      debug("heading: " + heading)
      debug("maxRadius: " + maxRadius)

      var gps_dist = _.get(app.signalk.self, "design.gpsDistaneFromAnchorDrop");
      if ( typeof gps_dist != 'undefined' )
      {
        maxRadius += gps_dist
      }
      /*
      var dist = (maxRadius / 1000) / 1.852
      dist /= (180*60/Math.PI)  // in radians

      debug("dist: " + dist)

      heading = (Math.PI*2)-heading

      var lat = Math.asin(Math.sin(degsToRad(position.latitude)) * Math.cos(dist) + Math.cos(degsToRad(position.latitude)) * Math.sin(dist) * Math.cos(heading))
      
      var dlon = Math.atan2(Math.sin(heading) * Math.sin(dist) * Math.cos(degsToRad(position.latitude)), Math.cos(dist) - Math.sin(degsToRad(position.latitude)) * Math.sin(lat))
      
      var lon = mod(degsToRad(position.longitude) - dlon + Math.PI, 2 * Math.PI) - Math.PI
      
      var newposition = { "latitude": radsToDeg(lat),
                          "longitude": radsToDeg(lon),
                          "altitude": depth * -1 }
      */
      var newposition = calc_position_from(position, heading, maxRadius)

      newposition['altitude'] = depth * -1;

      var delta = getAnchorDelta(app, newposition, maxRadius,
                                 maxRadius, false);
      app.signalk.addDelta(delta)
      
      var config = readJson(app, plugin.id)
      configuration = config["configuration"]
      
      delete configuration["position"]
      configuration["on"] = true
      configuration["radius"] = maxRadius
      configuration["position"] = newposition
        
      saveJson(app, plugin.id, config, res)
      if ( unsubscribe == null )
        startWatchingPosistion()
    })
  }
    
  plugin.id = "anchoralarm"
  plugin.name = "Anchor Alarm"
  plugin.description = "Plugin that checks the vessel possition to see if there's anchor drift"

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
        title: "Radius (m)",
        default: "60"
      },
      state: {
        title: "Alarm State",
        type: "string",
        default: "emergency",
        "enum": ["alert", "warn", "alarm", "emergency"]
      }      
    }
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

function calc_position_from(possition, heading, distance)
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
  

function checkPosition(app, radius, possition, anchor_position) {
  //debug("in checkPosition: " + possition.latitude + ',' + anchor_position.latitude)

  
  var meters = calc_distance(possition.latitude, possition.longitude,
                             anchor_position.latitude, anchor_position.longitude);

  debug("distance: " + meters + ", radius: " + radius);

  var delta = getAnchorDelta(app, anchor_position, meters, radius, false)
  app.signalk.addDelta(delta)
  
  return radius != null &&  meters > radius;
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
                "methods": [ "visual", "sound" ],
                "message": "Anchor Alarm",
                "timestamp": (new Date()).toISOString()
              }
            }]
        }
      ]
  }
  return delta;
}

function getAnchorDelta(app, position,
                        currentRadius, maxRadius, isSet)
{
  var value = null

  if ( position )
  {
    value = {
      "position": {
        "latitude": position.latitude,
        "longitude": position.longitude
      },
      "currentRadius": { "value": currentRadius },
      "maxRadius":  { "value": maxRadius },
      "timestamp": (new Date()).toISOString()
    }
  }
  else
  {
    value = {
      "position": null,
      "currentRadius": null,
      "maxRadius": null
    }
  }

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
              "path": "navigation.anchor",
              "value": value
            }]
        }
      ]
  }

  if ( position )
  {
    if ( isSet )
    {
      var depth = _.get(app.signalk.self,
		        'environment.depth.belowSurface.value')
      debug("depth: " + util.inspect(depth, {showHidden: false, depth: 6}))
      if ( typeof depth != 'undefined' )
      {
        delta['updates'][0]['values'][0]['value']['position']['altitude'] = -1 * depth
      }
    }
    else
    {
      var depth = _.get(app.signalk.self,
		        'navigation.anchor.position.altitude')
      if ( typeof depth != 'undefined' )
      {
        delta['updates'][0]['values'][0]['value']['position']['altitude'] = depth
      }
    }  
  }

  //debug("anchor delta: " + util.inspect(delta, {showHidden: false, depth: 6}))
  
  return delta;
}

function sendAnchorAlarm(sendit, app, state)
{
  if ( sendit )
  {
    var delta = getAnchorAlarmDelta(app, state)
    debug("send alarm: " + util.inspect(delta, {showHidden: false, depth: 6}))
    app.signalk.addDelta(delta)
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
  return path.join(app.config.appPath, "/plugin-config-data", id + '.json')
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
