// artifact-curator.js
// Tagging and version pruning logic for PortMyChat Pro.
// Loaded in the service worker (background.js) via importScripts.

var DISCARD_PATTERNS = [
  /^Screenshot/i,
  /^IMG_/,
  /^Untitled/i,
  /^screen/i,
  /\.tmp$/i,
  /^temp/i,
  /^debug/i
];

var KEEP_PATTERNS = [
  /Report/i,
  /Document/i,
  /Code/i,
  /Design/i,
  /Contract/i,
  /final/i,
  /\.pdf$/i,
  /\.docx$/i,
  /\.py$/i,
  /\.js$/i,
  /\.ts$/i,
  /\.jsx$/i,
  /\.tsx$/i
];

/**
 * Tag artifact as keeper or discard based on filename patterns.
 */
function tagArtifact(filename) {
  for (var i = 0; i < DISCARD_PATTERNS.length; i++) {
    if (DISCARD_PATTERNS[i].test(filename)) {
      return { tag: 'discard', reason: 'matches discard pattern' };
    }
  }
  for (var j = 0; j < KEEP_PATTERNS.length; j++) {
    if (KEEP_PATTERNS[j].test(filename)) {
      return { tag: 'keeper', reason: 'matches keep pattern' };
    }
  }
  return { tag: 'keeper', reason: 'default keep — no discard pattern matched' };
}

/**
 * Extract base filename and version number.
 * e.g., "code_v3.py" -> { base: "code", version: 3, ext: ".py" }
 */
function parseVersion(filename) {
  var patterns = [
    /^(.+?)_v(\d+)(\.\w+)?$/i,    // code_v1.py
    /^(.+?)_(\d+)(\.\w+)?$/,       // code_1.py
    /^(.+?)\s\((\d+)\)(\.\w+)?$/   // code (1).py
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = filename.match(patterns[i]);
    if (match) {
      return {
        base: match[1].trim(),
        version: parseInt(match[2], 10),
        ext: match[3] || ''
      };
    }
  }
  return null;
}

/**
 * Find all older versions of a new file in the stored artifact list.
 * Returns array of artifacts to mark as superseded.
 */
function pruneOldVersions(newFilename, allArtifacts) {
  var newParsed = parseVersion(newFilename);
  if (!newParsed) return [];

  var toSupersede = [];
  var names = Object.keys(allArtifacts);

  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (name === newFilename) continue;

    var artifact = allArtifacts[name];
    if (artifact.status === 'superseded') continue;

    var oldParsed = parseVersion(name);
    if (!oldParsed) continue;

    var sameBase = oldParsed.base.toLowerCase() === newParsed.base.toLowerCase();
    var sameExt = oldParsed.ext.toLowerCase() === newParsed.ext.toLowerCase();
    var isOlder = oldParsed.version < newParsed.version;

    if (sameBase && sameExt && isOlder) {
      toSupersede.push({ name: name, driveId: artifact.driveId || null });
    }
  }

  return toSupersede;
}
