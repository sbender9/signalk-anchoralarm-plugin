/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
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

module.exports = function(app) {
  var plugin = {};
  var anchor_position
  var alarm_sent = false
  var unsubscribe = undefined

  plugin.start = function(props) {
    debug("starting with props: " + props)

    try {
      unsubscribe = Bacon.combineWith(function(position) {
        if (anchor_position == null)
        {
          debug("set anchor position to: " + position.latitude + " " + position.longitude)
          anchor_position = position
          return false
        }
        else
        {
          var res = checkPosition(props.radius, position, anchor_position)
          var was_sent = alarm_sent
          alarm_sent = res
          return res && !was_sent
        }}, ['navigation.position' ].map(app.streambundle.getOwnStream, app.streambundle)).changes().debounceImmediate(5000).onValue(sendit => {
          sendAnchorAlarm(sendit,app)
        })
    } catch (e) {
      plugin.started = false
      debug("error: " + e);
      return e
    }
    debug("started")
  };

  plugin.stop = function(app) {
    debug("stopping")
    if ( alarm_sent )
    {
      var delta = getAnchorAlarmDelta(app, "normal")
      app.signalk.addDelta(delta)
    }
    if (unsubscribe) {
      unsubscribe()
    }
    debug("stopped")
  }
  
  plugin.id = "anchoralarm"
  plugin.name = "Anchor Alarm"
  plugin.description = "Plugin that checks the vessel possition to see if there's anchor drift"

  plugin.schema = {
    title: "Anchor Alarm",
    type: "object",
    required: [
      "radius"
    ],
    properties: {
      radius: {
        type: "string",
        title: "Radius (m)",
        default: "200"
      }
    }
  }

  return plugin;
}

function calc_distance(lat1,lon1,lat2,lon2) {
  var R = 6371000; // Radius of the earth in m
  var dLat = degsToRad(lat2-lat1);  // deg2rad below
  var dLon = degsToRad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(degsToRad(lat1)) * Math.cos(degsToRad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; // Distance in km
  return d;
}


function checkPosition(radius, possition, anchor_position) {
  debug("in checkPosition: " + possition.latitude + ',' + anchor_position.latitude)

  
  var meters = calc_distance(possition.latitude, possition.longitude,
                             anchor_position.latitude, anchor_position.longitude);

  debug("distance: " + meters);
  
  return meters > radius;
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

function sendAnchorAlarm(sendit, app)
{
  if ( sendit )
  {
    var delta = getAnchorAlarmDelta(app, "alarm")
    app.signalk.addDelta(delta)
  }
}

function radsToDeg(radians) {
  return radians * 180 / Math.PI
}

function degsToRad(degrees) {
  return degrees * (Math.PI/180.0);
}


function mpsToKn(mps) {
  return 1.9438444924574 * mps
}
