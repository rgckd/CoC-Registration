function createStudyGroups() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inputSheet = ss.getSheets()[0];
  var outputSheet = ss.getSheetByName("Study Groups");
  if (!outputSheet) {
    outputSheet = ss.insertSheet("Study Groups");
  }
  outputSheet.clearContents();

  // Set headers
  var headers = ["Group", "Name", "Email", "Mobile", "Common Day and Time", "English Fluency", "Coordinator", "Center", "All Availability", "Unassigned Reason"];
  outputSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");

  var data = inputSheet.getDataRange().getValues();
  if (data.length < 2) {
    outputSheet.getRange(2, 1).setValue("Error: No data rows found in input sheet.");
    return;
  }

  var timeMap = {
    "காலை (8am - 11am)": "Morning",
    "மதியம் (12 noon - 4pm)": "Afternoon",
    "மாலை (5pm - 9pm)": "Evening"
  };

  var participants = [];
  var days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // Parse input data
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[1]) {
      Logger.log(`Skipping row ${i + 1}: Missing email`);
      continue;
    }

    var avail = {};
    var allAvail = [];
    for (var d = 0; d < 7; d++) {
      var col = 6 + d;
      var val = row[col] ? row[col].toString().split(',').map(function(s) { return s.trim(); }) : [];
      var timesSet = new Set();
      for (var v of val) {
        if (timeMap[v]) {
          timesSet.add(timeMap[v]);
          allAvail.push(days[d] + " " + timeMap[v]);
        } else if (v) {
          Logger.log(`Row ${i + 1}, Col ${String.fromCharCode(71 + d)}: Invalid availability '${v}'`);
        }
      }
      avail[days[d]] = timesSet;
    }

    var fluent = row[5] === "ஆம் (Yes)";
    var coordinate = row[13] === "ஆம் (Yes)";
    if (row[5] && row[5] !== "ஆம் (Yes)" && row[5] !== "இல்லை (No)") {
      Logger.log(`Row ${i + 1}, Col F: Invalid fluency value '${row[5]}'`);
    }
    if (row[13] && row[13] !== "ஆம் (Yes)" && row[13] !== "இல்லை (No)") {
      Logger.log(`Row ${i + 1}, Col N: Invalid coordinator value '${row[13]}'`);
    }

    participants.push({
      name: row[2] || `Unknown_${i + 1}`,
      email: row[1],
      mobile: row[3] || '',
      center: row[4] || '',
      fluent: fluent,
      coordinate: coordinate,
      availability: avail,
      allAvailability: allAvail.length > 0 ? allAvail.join(", ") : "None",
      unassignedReason: ""
    });
  }

  if (participants.length < 5) {
    outputSheet.getRange(2, 1).setValue(`Error: Not enough valid participants (${participants.length}) to form a group (minimum 5).`);
    return;
  }

  Logger.log(`Total participants: ${participants.length}`);

  participants.sort(function(a, b) {
    return a.center.localeCompare(b.center) || a.name.localeCompare(b.name);
  });

  var groups = [];
  var unassigned = participants.slice();
  var times = ['Morning', 'Afternoon', 'Evening'];

  // Function to form groups from a list for a given day and time
  function formGroupsFromList(list, day, time) {
    if (list.length < 5) {
      list.forEach(function(p) {
        if (!p.unassignedReason) {
          p.unassignedReason = `Insufficient participants (${list.length}) for ${day} ${time}`;
        }
      });
      return {formed: [], used: new Set()};
    }

    list.sort(function(a, b) { return a.name.localeCompare(b.name); });

    var num_fluent = list.filter(function(p) { return p.fluent; }).length;
    var num_coord = list.filter(function(p) { return p.coordinate; }).length;
    if (num_fluent < 1) {
      list.forEach(function(p) {
        if (!p.unassignedReason) {
          p.unassignedReason = `No fluent English speaker available for ${day} ${time}`;
        }
      });
      return {formed: [], used: new Set()};
    }
    if (num_coord < 1) {
      list.forEach(function(p) {
        if (!p.unassignedReason) {
          p.unassignedReason = `No coordinator available for ${day} ${time}`;
        }
      });
      return {formed: [], used: new Set()};
    }

    var max_possible_k = Math.min(num_fluent, num_coord, Math.floor(list.length / 5));
    var best_k = 0;
    var max_covered = 0;
    for (var k = 1; k <= max_possible_k; k++) {
      if (list.length >= k * 5) {
        var covered = Math.min(list.length, k * 7);
        if (covered > max_covered) {
          max_covered = covered;
          best_k = k;
        }
      }
    }

    if (best_k === 0) {
      list.forEach(function(p) {
        if (!p.unassignedReason) {
          p.unassignedReason = `Cannot form group of 5-7 for ${day} ${time}`;
        }
      });
      return {formed: [], used: new Set()};
    }

    var fluent_list = list.filter(function(p) { return p.fluent; }).sort(function(a, b) { return a.name.localeCompare(b.name); });
    var coord_list = list.filter(function(p) { return p.coordinate; }).sort(function(a, b) { return a.name.localeCompare(b.name); });
    var group_list = Array.from({length: best_k}, function() { return []; });
    var assigned_in_list = new Set();

    // Assign fluents and coordinators to maximize overlap
    for (var i = 0; i < best_k; i++) {
      var candidate = fluent_list[i];
      if (candidate && candidate.coordinate) {
        // Prefer fluent coordinators to maximize group efficiency
        group_list[i].push(candidate);
        assigned_in_list.add(candidate);
      } else {
        if (!fluent_list[i]) {
          list.forEach(function(p) {
            if (!p.unassignedReason) {
              p.unassignedReason = `Insufficient fluent speakers for ${day} ${time}`;
            }
          });
          return {formed: [], used: new Set()};
        }
        group_list[i].push(fluent_list[i]);
        assigned_in_list.add(fluent_list[i]);
      }
    }

    // Assign additional coordinators if needed
    var remaining_coords = coord_list.filter(function(c) { return !assigned_in_list.has(c); });
    var coord_idx = 0;
    for (var gi = 0; gi < best_k; gi++) {
      var g = group_list[gi];
      var has_c = g.some(function(p) { return p.coordinate; });
      if (!has_c) {
        if (!remaining_coords[coord_idx]) {
          list.forEach(function(p) {
            if (!p.unassignedReason) {
              p.unassignedReason = `Insufficient coordinators for ${day} ${time}`;
            }
          });
          return {formed: [], used: new Set()};
        }
        var coord = remaining_coords[coord_idx++];
        g.push(coord);
        assigned_in_list.add(coord);
      }
    }

    // Remaining people
    var remaining = list.filter(function(p) { return !assigned_in_list.has(p); });

    // Fill to 5
    for (var gi = 0; gi < best_k; gi++) {
      var g = group_list[gi];
      while (g.length < 5 && remaining.length > 0) {
        var p = remaining.shift();
        g.push(p);
        assigned_in_list.add(p);
      }
    }

    // Distribute rest round-robin
    var gi = 0;
    while (remaining.length > 0) {
      var start = gi;
      do {
        if (group_list[gi].length < 7) {
          var p = remaining.shift();
          group_list[gi].push(p);
          assigned_in_list.add(p);
          gi = (gi + 1) % best_k;
          break;
        }
        gi = (gi + 1) % best_k;
      } while (gi !== start);
      if (gi === start) break;
    }

    // Create group objects
    var formed = [];
    for (var g of group_list) {
      g.sort(function(a, b) { return a.name.localeCompare(b.name); });
      formed.push({
        members: g,
        day: day,
        time: time
      });
    }

    return {formed: formed, used: assigned_in_list};
  }

  // First pass: same center
  for (var di = 0; di < days.length; di++) {
    var day = days[di];
    for (var ti = 0; ti < times.length; ti++) {
      var time = times[ti];
      var available = unassigned.filter(function(p) { return p.availability[day].has(time); });
      if (available.length < 5) continue;

      var center_map = new Map();
      available.forEach(function(p) {
        if (!center_map.has(p.center)) center_map.set(p.center, []);
        center_map.get(p.center).push(p);
      });

      var center_entries = Array.from(center_map.entries()).sort(function(a, b) { return b[1].length - a[1].length; });

      for (var ce = 0; ce < center_entries.length; ce++) {
        var list = center_entries[ce][1];
        var result = formGroupsFromList(list, day, time);
        if (result.formed.length > 0) {
          groups = groups.concat(result.formed);
          unassigned = unassigned.filter(function(p) { return !result.used.has(p); });
        }
      }
    }
  }

  // Second pass: mixed centers
  for (var di = 0; di < days.length; di++) {
    var day = days[di];
    for (var ti = 0; ti < times.length; ti++) {
      var time = times[ti];
      var available = unassigned.filter(function(p) { return p.availability[day].has(time); });
      var result = formGroupsFromList(available, day, time);
      if (result.formed.length > 0) {
        groups = groups.concat(result.formed);
        unassigned = unassigned.filter(function(p) { return !result.used.has(p); });
      }
    }
  }

  // Final check for unassigned participants
  unassigned.forEach(function(p) {
    if (!p.unassignedReason) {
      p.unassignedReason = p.allAvailability === "None" ? "No availability specified" : "No matching group found";
    }
  });

  // Write output
  var outputData = [];
  var groupNum = 1;
  for (var gi = 0; gi < groups.length; gi++) {
    var grp = groups[gi];
    var common = grp.day + " " + grp.time;
    var first = true;
    for (var mi = 0; mi < grp.members.length; mi++) {
      var m = grp.members[mi];
      var row = [
        first ? "Group " + ("0" + groupNum).slice(-2) : "",
        m.name,
        m.email,
        m.mobile,
        common,
        m.fluent ? "Fluent" : "No English",
        m.coordinate ? "Yes" : "",
        m.center,
        m.allAvailability,
        ""
      ];
      outputData.push(row);
      first = false;
    }
    groupNum++;
  }

  // Add unassigned participants to Group NA
  if (unassigned.length > 0) {
    var first = true;
    for (var p of unassigned) {
      var row = [
        first ? "Group NA" : "",
        p.name,
        p.email,
        p.mobile,
        "",
        p.fluent ? "Fluent" : "No English",
        p.coordinate ? "Yes" : "",
        p.center,
        p.allAvailability,
        p.unassignedReason
      ];
      outputData.push(row);
      first = false;
    }
  }

  if (outputData.length > 0) {
    outputSheet.getRange(2, 1, outputData.length, headers.length).setValues(outputData);
  } else {
    outputSheet.getRange(2, 1).setValue("No groups formed or participants assigned.");
  }
}