/**
 * JSON state in Script Properties. A single property holds at most ~9 KB,
 * so values are split across numbered keys.
 */
var CHUNK_ = 8000;

function storeGet_(name, fallback) {
  var props = PropertiesService.getScriptProperties();
  var n = parseInt(props.getProperty('ds_' + name + '_n') || '0', 10);
  if (!n) return fallback;
  var s = '';
  for (var i = 0; i < n; i++) s += props.getProperty('ds_' + name + '_' + i) || '';
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function storeSet_(name, value) {
  var props = PropertiesService.getScriptProperties();
  var s = JSON.stringify(value);
  var old = parseInt(props.getProperty('ds_' + name + '_n') || '0', 10);
  var batch = {}, n = Math.max(1, Math.ceil(s.length / CHUNK_));
  for (var i = 0; i < n; i++) batch['ds_' + name + '_' + i] = s.substr(i * CHUNK_, CHUNK_);
  batch['ds_' + name + '_n'] = String(n);
  props.setProperties(batch);
  for (var j = n; j < old; j++) props.deleteProperty('ds_' + name + '_' + j);
}

function secret_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/** Items -> JSON-safe (Dates as ISO) and back. */
function packItems_(items) {
  return items.map(function (it) {
    var o = {}; for (var k in it) o[k] = it[k];
    o.due = iso_(it.due);
    return o;
  });
}
function unpackItems_(arr) {
  return (arr || []).map(function (o) { o.due = new Date(o.due); return o; });
}
