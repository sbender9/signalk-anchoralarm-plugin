# Signal K Anchor Alarm Plugin

A Signal K server plugin that monitors vessel position for anchor drift and provides comprehensive anchor management functionality.

## Features

- **Real-time anchor drift monitoring** with configurable alarm radius
- **Automatic radius calculation** based on rode length and depth
- **Intelligent anchor position detection** with depth-based and rode length-based activation methods
- **Web-based interface** with interactive map showing vessel position, anchor position, and alarm radius
- **REST API** for programmatic control
- **Signal K PUT handlers** for standardized integration
- **Position tracking** and history
- **Multiple alarm types** including incomplete anchor alarms and no-position warnings
- **GPS bow offset compensation** for accurate anchor position calculation

## Installation

Install through the Signal K app store or via npm:

```bash
npm install signalk-anchoralarm-plugin
```

## Configuration

Configure the plugin through the Signal K server admin interface or by editing the plugin configuration:

- **Alarm Delay**: Time in seconds before sending an alarm after leaving the radius (default: 0)
- **Warning Percentage**: Percentage of alarm radius to trigger a warning (0 to disable)
- **No Position Alarm**: Time in seconds to wait before alarming if no GPS position received
- **Fudge Factor**: Additional meters added to calculated radius for GPS accuracy
- **Bow Height**: Height of bow from water in meters (for rode length calculations)
- **Alarm State**: Notification severity level (`alert`, `warn`, `alarm`, `emergency`)
- **Incomplete Anchor Alarm**: Minutes before warning if anchoring process not completed

### Rode Counter Automation

The plugin supports automatic anchor position detection based on rode counter data:

- **Enable Rode Counter Automation**: Automatically control anchor alarm based on rode counter value
- **Rode Counter Path**: Signal K path for rode counter data (default: `navigation.anchor.rodeCounterLength`)
- **Activation Method**: Choose how anchor position is detected:
  - **Depth**: Sets anchor position when anchor reaches the seabed (calculated using water depth + bow height)
  - **Rode length**: Sets anchor position when rode counter reaches specified threshold length
- **Rode Deployment Threshold**: Rode length threshold for "Rode length" activation method (default: 5 meters)
- **Rode Stabilization Time**: Wait time after rode stops changing before completing anchoring (default: 10 seconds)
- **Use Rode Counter as Radius**: Calculate alarm radius from rode counter instead of GPS position

#### Depth-Based Activation

When "Activation Method" is set to "Depth", the plugin monitors `environment.depth.belowSurface` and automatically sets the anchor position when the anchor reaches the seabed. The threshold is calculated as:

```
threshold = water_depth + bow_height
```

This method provides more intelligent anchor detection by using actual water depth rather than relying solely on rode length, making it suitable for varying seabed conditions and anchor types.

**Requirements for depth-based activation:**
- A depth sensor providing `environment.depth.belowSurface` data
- Properly configured bow height for accurate depth calculations
- A rode counter providing rode length data

## Usage

### Web Interface

Access the interactive web application at:

```
http://[signalk-server-ip]:[port]/signalk-anchoralarm-plugin/
```

Optional URL parameters for map display:

- `/?openseamap` - Enable OpenSeaMap overlay
- `/?satellite` - Use satellite imagery
- `/?satellite&openseamap` - Both satellite and OpenSeaMap

**Note**: You must be logged into the Signal K admin interface for the web app to function.

### REST API

The plugin provides several REST endpoints for anchor management:

#### Drop Anchor

Sets the anchor position based on current vessel position (adjusted for bow GPS offset).

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"radius": 25}' \
  http://localhost:3000/plugins/anchoralarm/dropAnchor
```

#### Set Alarm Radius

Calculate radius based on current distance from anchor, or set a specific radius.

```bash
# Auto-calculate from current position
curl -X POST -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3000/plugins/anchoralarm/setRadius

# Set specific radius in meters
curl -X POST -H "Content-Type: application/json" \
  -d '{"radius": 30}' \
  http://localhost:3000/plugins/anchoralarm/setRadius
```

#### Set Rode Length

Calculate alarm radius from anchor rode length and depth.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"length": 50}' \
  http://localhost:3000/plugins/anchoralarm/setRodeLength
```

The plugin automatically calculates the maximum swing radius using:

- Rode length
- Water depth (from depth sensor or manual input)
- Bow height configuration
- GPS antenna offset from bow

#### Set Manual Anchor Position

Estimate anchor position based on heading, depth, and rode length.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"anchorDepth": 4.5, "rodeLength": 45}' \
  http://localhost:3000/plugins/anchoralarm/setManualAnchor
```

#### Raise Anchor

Clear anchor position and disable alarm monitoring.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3000/plugins/anchoralarm/raiseAnchor
```

#### Set Anchor Position

Manually set the anchor position coordinates.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"position": {"latitude": 37.8267, "longitude": -122.4233}}' \
  http://localhost:3000/plugins/anchoralarm/setAnchorPosition
```

#### Get Position Track

Retrieve vessel position history (up to 24 hours).

```bash
curl http://localhost:3000/plugins/anchoralarm/getTrack
```

### Signal K PUT Handlers

The plugin registers PUT handlers for standard Signal K paths:

#### Set Anchor Position

```javascript
// Set anchor position
PUT vessels.self.navigation.anchor.position
{
  "latitude": 37.8267,
  "longitude": -122.4233,
  "altitude": -4.5  // depth in meters (negative)
}

// Clear anchor position
PUT vessels.self.navigation.anchor.position
null
```

#### Set Maximum Radius

```javascript
PUT vessels.self.navigation.anchor.maxRadius
25  // radius in meters
```

#### Set Rode Length

```javascript
PUT vessels.self.navigation.anchor.rodeLength
50  // length in meters
```

## Signal K Data Published

The plugin publishes the following Signal K data paths:

- `navigation.anchor.position` - Anchor position (lat/lon/alt)
- `navigation.anchor.maxRadius` - Maximum alarm radius in meters
- `navigation.anchor.bearingTrue` - True bearing from vessel to anchor
- `navigation.anchor.apparentBearing` - Apparent bearing accounting for vessel heading
- `navigation.anchor.rodeLength` - Anchor rode length in meters
- `navigation.anchor.fudgeFactor` - Additional radius for GPS accuracy
- `navigation.anchor.distanceFromBow` - Distance from bow to anchor

## Notifications

The plugin sends Signal K notifications for various alarm conditions:

- **Anchor drag alarm** - When vessel exceeds the configured radius
- **Position warning** - When approaching the warning percentage of radius
- **No position alarm** - When GPS position is not received within configured time
- **Incomplete anchor alarm** - When anchoring process isn't completed within configured time

## Integration

### WilhelmSK

The plugin is fully compatible with [WilhelmSK](https://itunes.apple.com/us/app/wilhelmsk/id1150499484?mt=8) for setting and monitoring anchor alarms.

### Other Signal K Apps

Any Signal K client can monitor anchor status through the standard Signal K paths and use the PUT handlers for control.

## Technical Details

- Monitors position at 1-second intervals when anchor alarm is active
- Maintains 24-hour position track history (1-minute resolution)
- Automatically persists anchor state across server restarts
- Calculates accurate anchor swing radius accounting for water depth and rode geometry
- Supports GPS antenna bow offset compensation for precise anchor positioning
- **Depth-based anchor detection**: Automatically detects when anchor reaches seabed using water depth sensor data
- **Rode counter automation**: Monitors rode deployment and automatically manages anchor position and alarm radius

## License

ISC License - see LICENSE file for details.

- **Value**: Position object with `latitude`, `longitude`, and optionally `altitude` properties, or `null` to raise the anchor
- **Behavior**:
  - When a position is provided, sets the anchor position and starts monitoring if a radius is configured
  - When `null` is provided, raises the anchor and stops monitoring
- **Example PUT request**:

```json
{
  "context": "vessels.self",
  "requestId": "12345",
  "put": {
    "path": "navigation.anchor.position",
    "value": {
      "latitude": 37.7749,
      "longitude": -122.4194,
      "altitude": -5.2
    }
  }
}
```

- **Example curl command**:

```bash
curl -X PUT -H "Content-Type: application/json" \
  -d '{"value":{"latitude":37.7749,"longitude":-122.4194,"altitude":-5.2}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/navigation/anchor/position
```

- **To raise the anchor (set position to null)**:

```bash
curl -X PUT -H "Content-Type: application/json" \
  -d '{"value":null}' \
  http://localhost:3000/signalk/v1/api/vessels/self/navigation/anchor/position
```

#### navigation.anchor.maxRadius

- **Path**: `vessels.self.navigation.anchor.maxRadius`
- **Purpose**: Set the maximum anchor alarm radius in meters
- **Value**: Number representing radius in meters
- **Behavior**: Sets the alarm radius and starts monitoring if an anchor position is already set
- **Example PUT request**:

```json
{
  "context": "vessels.self",
  "requestId": "12346",
  "put": {
    "path": "navigation.anchor.maxRadius",
    "value": 50
  }
}
```

- **Example curl command**:

```bash
curl -X PUT -H "Content-Type: application/json" \
  -d '{"value":50}' \
  http://localhost:3000/signalk/v1/api/vessels/self/navigation/anchor/maxRadius
```

#### navigation.anchor.rodeLength

- **Path**: `vessels.self.navigation.anchor.rodeLength`
- **Purpose**: Set the anchor rode length and automatically calculate the appropriate alarm radius
- **Value**: Number representing rode length in meters
- **Behavior**:
  - Sets the rode length value in the Signal K data
  - Automatically calculates and sets the anchor position based on current vessel position, heading, depth, and configuration
  - Starts anchor monitoring with the calculated parameters
- **Example PUT request**:

```json
{
  "context": "vessels.self",
  "requestId": "12347",
  "put": {
    "path": "navigation.anchor.rodeLength",
    "value": 30
  }
}
```

- **Example curl command**:

```bash
curl -X PUT -H "Content-Type: application/json" \
  -d '{"value":30}' \
  http://localhost:3000/signalk/v1/api/vessels/self/navigation/anchor/rodeLength
```

### Using PUT

These put handlers can be triggered by:

- Signal K apps (like WilhelmSK)
- Other plugins
- Direct HTTP PUT requests to the Signal K server's REST API
- WebSocket PUT messages

The handlers provide a more standardized interface compared to the plugin-specific REST endpoints, following Signal K conventions for data paths and PUT handling.
