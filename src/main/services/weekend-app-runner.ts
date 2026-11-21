import { appLaunchKey } from '../../shared/app-launch'

// Standalone JXA program. launchd runs it in the user's session even when Kudu is closed.
// All paths come through argv or JSON data, never through executable script interpolation.
export const WEEKEND_APP_RUNNER = `
ObjC.import('Foundation')
var appLaunchKey = ${appLaunchKey.toString()}
function readJSON(path) {
  var text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)
  if (!text) throw new Error('Cannot read ' + path)
  return JSON.parse(ObjC.unwrap(text))
}
function saveJSON(path, value) {
  if (!$(JSON.stringify(value)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) {
    throw new Error('Cannot save launch receipt')
  }
}
function run(argv) {
  var now = new Date()
  var directory = argv[0]
  var config = readJSON(directory + '/config.json')
  var key = appLaunchKey(now, config.policy)
  if (!key) return
  var statePath = directory + '/state.json'
  var state = { weekend: null, lastOpened: null, lastError: null }
  if ($.NSFileManager.defaultManager.fileExistsAtPath(statePath)) state = readJSON(statePath)
  if (state.weekend === key) return
  if (state.lastOpened) {
    var priorPolicy = { days: [0,1,2,3,4,5,6], frequency: config.policy ? config.policy.frequency : 'weekly' }
    if (appLaunchKey(new Date(state.lastOpened), priorPolicy) === key) return
  }
  var task = $.NSTask.alloc.init
  task.launchPath = '/usr/bin/open'
  task.arguments = ['-a', config.appPath]
  task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice
  try {
    task.launch
    task.waitUntilExit
    if (task.terminationStatus !== 0) throw new Error('macOS could not open the application')
    state.weekend = key
    state.lastOpened = now.toISOString()
    state.lastError = null
    saveJSON(statePath, state)
  } catch (error) {
    state.lastError = String(error)
    saveJSON(statePath, state)
    throw error
  }
}
`
