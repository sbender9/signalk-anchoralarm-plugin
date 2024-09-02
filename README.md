# signalk-anchoralarm-plugin

[![Greenkeeper badge](https://badges.greenkeeper.io/sbender9/signalk-anchoralarm-plugin.svg)](https://greenkeeper.io/)

SignalK Node Server Anchor Alarm Plugin

Then use WilhelmSK to set the alarm (https://itunes.apple.com/us/app/wilhelmsk/id1150499484?mt=8)

If not using WilhelmSK, you can setup the alarm using the WebApp or the REST API.

## Web App

Point your Web Browser to http://[signalk-server-ip-address]:[port-number]/signalk-anchoralarm-plugin/

If you wish to have the satellite or openseamaps view enabled by default add the following

| OpenStreetMap | Satellite | OpenSeaMap | Url String |
| ------------- | --------- | ---------- | -----------|
| X | - | - | / |
| X | - | X | /?openseamap |
| - | X | - | /?satellite |
| - | X | X | /?satellite&openseamap |

Note that you must be logged in to SignalK UI for this to work.

When a depth transducer is configured the plugin will default to an anchor alarm of Dx5. If no depth transducer can be found the web app will prompt for the anchor alarm radius when the anchor is droped.

## REST API

### When you drop the anchor in the water, Call dropAnchor:


```
curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:3000/plugins/anchoralarm/dropAnchor
```

### After you have let the anchor rode out, call setRadius. This will calculate and set the alarm radius based on the vessels current position.

```
curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:3000/plugins/anchoralarm/setRadius
```

### Alternately, after you have let the anchor rode out, call setRodeLength. This will calculate and set the alarm radius based on rode length, depth and bow height.

```
curl -X POST -H "Content-Type: application/json" -d '{"length": 30}' http://localhost:3000/plugins/anchoralarm/setRodeLength
```


### You can adjust the radius (in meters) via:

```
curl -X POST -H "Content-Type: application/json" -d '{"radius": 30}' http://localhost:3000/plugins/anchoralarm/setRadius
```

### When you raise the anchor, call raiseAnchor.

```
curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:3000/plugins/anchoralarm/raiseAnchor
```

### If you need to set the anchor position after you have already let the rode out, it can esitmate the andchor position based on heading, depth and rode length. If "anchorDepth" is left out, then the current depthFromSurface will be used if available.

```
curl -X POST -H "Content-Type: application/json" -d '{"anchorDepth": 3, "rodeLength":30}' http://localhost:3000/plugins/anchoralarm/setManualAnchor
```


