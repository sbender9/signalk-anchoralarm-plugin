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

const debug = require('debug')('meta-alarms')

const Bacon = require('baconjs');

const util = require('util')

const _ = require('lodash')

module.exports = function(app) {
  var plugin = {};
  var anchor_position
  var alarm_sent = false
  var unsubscribe = undefined

  plugin.start = function(props) {

    debug(typeof app.config.defaults.vessels.self)
    try
    {
      _.forIn(app.config.defaults.vessels.self, function(value, this_key) {
        meta_iterator(app, null, value, this_key)
      })
    } catch (e) {
      plugin.started = false
      debug("error: " + e);
      return e
    }
    debug("started")
  };

  plugin.stop = function() {
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
  
  plugin.id = "meta-alarms"
  plugin.name = "Meta Alarms"
  plugin.description = "Plugin that checks the vessel possition to see if there's anchor drift"

  plugin.schema = {
    title: "Meta Alarms",
    type: "object",
    required: [
      "radius"
    ],
    properties: {
      radius: {
        type: "string",
        title: "Radius (m)",
        default: "60"
      }
    }
  }

  return plugin;
}

function meta_iterator(app, parent, value, key)
{
  if ( value.meta )
  {
    if ( value.meta.zones )
    {
      var path = parent + "." + key

      var unsubscribe = Bacon.combineWith(function(current) {
        //debug("got: " + path + " = " + current)
        var res = checkAlarm(app, path, value.meta.zones, current)
        return res
      }, [ path ].map(app.streambundle.getOwnStream, app.streambundle)).changes().debounceImmediate(1000).onValue(sendit => {
        sendAlarm(app, sendit)
      })
    }
  }
  else if ( "object" == typeof value )
  {
    _.forIn(value, function(value, this_key) {
      var parent_key = parent != null ? parent + "." + key : key 
      meta_iterator(app, parent_key, value, this_key)
    })
  }
}

function checkAlarm(app, path, zones, value)
{
  var last_upper
  var last_lower
  var alarm = null

  state_zones = zones.filter(function(zone) {
    return zone['state']
  });
                            
  all = state_zones.filter(function(zone) {
    //debug(path + ": " + zone.lower + "," + zone.upper + ", " + value)
    return (zone.lower == null || value >= zone.lower)
      && (zone.upper == null || value < zone.upper) 
  })

  var zone
  if ( all.length > 0 )
  {
    zone = all[all.length-1]
  }
  return createAlarm(app, path, zone, value)
}

function alarmKeyFromPath(path)
{
  var parts = path.split('.')
  var res = parts[0]
  for ( var i = 1; i < parts.length; i++ )
  {
    res = res + parts[i].charAt(0).toUpperCase() + parts[i].slice(1);
  }
  return res
}

function getAlarmDelta(app, path, state, message)
{
  var delta = {
      "context": "vessels." + app.selfId,
      "updates": [
        {
          "source": {
            "label": "meta-alarms-plugin"
          },
          "timestamp": (new Date()).toISOString(),
          "values": [
            {
              "path": path,
              "value": {
                "state": state,
                "methods": [ "visual", "sound" ],
                "message": message,
                "timestamp": (new Date()).toISOString()
              }
            }]
        }
      ]
  }
  return delta;
}


function createAlarm(app, path, zone, value)
{
  var notificationPath = "notifications." + alarmKeyFromPath(path)

  var existing = _.get(app.signalk.self, notificationPath)

  var state = zone ? zone.state : 'normal'
  
  if ( existing && existing.state == state )
    return null
  else if ( !existing && state == 'normal' )
    return null
  
  var message
  if ( zone )
    message = zone.message

  if ( typeof message === 'undefined' )
    message = path + " is " + value
  
  return getAlarmDelta(app, notificationPath, state, message)
}

function sendAlarm(app, delta)
{
  if ( delta )
  {
    debug("sendAlarm: " + util.inspect(delta, {showHidden: false, depth: null}))
    app.signalk.addDelta(delta)
  }
}

