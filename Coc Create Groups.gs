/************************************************
 * MENU
 ************************************************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("CoC Admin")
    .addItem("Populate Participants (All Languages)", "populateParticipantsFromCustomForm")
    .addSeparator()
    .addItem("Suggest Groups – English", "suggestGroupsEnglish")
    .addItem("Suggest Groups – Tamil", "suggestGroupsTamil")
    .addItem("Suggest Groups – Hindi", "suggestGroupsHindi")
    .addItem("Suggest Groups – Kannada", "suggestGroupsKannada")
    .addItem("Suggest Groups – Telugu", "suggestGroupsTelugu")
    .addSeparator()
    .addItem("Accept Group Suggestions", "acceptGroupSuggestions")
    .addSeparator()
    .addItem("Refresh Groups and Dashboard", "refreshGroupsAndDashboard")
    .addToUi();
}

/************************************************
 * MENU WRAPPERS (Apps Script requires these)
 ************************************************/
function suggestGroupsEnglish() { suggestGroupsForLanguage("English"); }
function suggestGroupsTamil() { suggestGroupsForLanguage("Tamil"); }
function suggestGroupsHindi() { suggestGroupsForLanguage("Hindi"); }
function suggestGroupsKannada() { suggestGroupsForLanguage("Kannada"); }
function suggestGroupsTelugu() { suggestGroupsForLanguage("Telugu"); }

/************************************************
 * POPULATE PARTICIPANTS FROM CustomForm
 ************************************************/
function populateParticipantsFromCustomForm() {
  const ss = SpreadsheetApp.getActive();
  const src = ss.getSheetByName("CustomForm");
  const tgt = ss.getSheetByName("Participants");

  // Get initial data and headers
  let sData = src.getDataRange().getValues();
  let sHeaders = sData[0];
  
  // Check if "Processed" column exists, if not add it
  let processedColIndex = sHeaders.indexOf("Processed");
  if (processedColIndex === -1) {
    const lastCol = src.getLastColumn();
    src.getRange(1, lastCol + 1).setValue("Processed");
    // Re-fetch data with the new column
    sData = src.getDataRange().getValues();
    sHeaders = sData[0];
    processedColIndex = sHeaders.indexOf("Processed");
  }
  
  const tData = tgt.getDataRange().getValues();
  const tHeaders = tData.shift();
  
  // Remove headers from source data
  sData.shift();

  const sIdx = indexMap(sHeaders);
  const tIdx = indexMap(tHeaders);

  let nextId = getNextParticipantIdStart(tgt, tIdx.ParticipantID);
  let rows = [];
  let processedRowIndices = [];

  sData.forEach((r, index) => {
    const email = r[sIdx.Email];
    const isProcessed = r[sIdx.Processed] === true || r[sIdx.Processed] === "TRUE";
    
    if (!email || isProcessed) return;

    const newRow = new Array(tHeaders.length).fill("");
    newRow[tIdx.ParticipantID] = "P-" + String(nextId++).padStart(4, "0");
    newRow[tIdx.Name] = r[sIdx.Name];
    newRow[tIdx.Email] = email;
    newRow[tIdx.WhatsApp] = r[sIdx.WhatsApp];
    newRow[tIdx.Language] = normalizeLanguage(r[sIdx.Language]);
    newRow[tIdx.Center] = r[sIdx.Center];
    newRow[tIdx.PreferredSlots] = r[sIdx.PreferredTimes];
    newRow[tIdx.CoordinatorWilling] = r[sIdx.Coordinator] === "Yes";
    newRow[tIdx.AssignedGroup] = "";
    newRow[tIdx.AssignmentStatus] = "Unassigned";
    newRow[tIdx.IsGroupCoordinator] = false;
    newRow[tIdx.AcceptSuggestion] = false;
    newRow[tIdx.SuggestedGroup] = "";
    if (tIdx.Notes !== undefined) newRow[tIdx.Notes] = "";
    if (tIdx.IsActive !== undefined) newRow[tIdx.IsActive] = true;

    rows.push(newRow);
    processedRowIndices.push(index + 2); // +2 because of header row and 1-based indexing
  });

  if (rows.length) {
    tgt.getRange(tgt.getLastRow() + 1, 1, rows.length, rows[0].length)
      .setValues(rows);
    
    // Mark processed rows in CustomForm using column index + 1 (1-based)
    processedRowIndices.forEach(rowNum => {
      src.getRange(rowNum, sIdx.Processed + 1).setValue(true);
    });
  }
}

/************************************************
 * SUGGEST GROUPS (LANGUAGE SCOPED)
 ************************************************/
function suggestGroupsForLanguage(language) {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  ensureGroupIds(gSheet, gData, gIdx);

  const participants = pData
    .map((r, i) => ({ row: i + 2, data: r }))
    .filter(p =>
      p.data[pIdx.Language] === language &&
      p.data[pIdx.AssignmentStatus] === "Unassigned"
    );

  // Group participants by first preferred time slot
  const slotGroups = {};
  participants.forEach(p => {
    const slots = splitSlots(p.data[pIdx.PreferredSlots]);
    const firstSlot = slots[0] || "TBD";
    if (!slotGroups[firstSlot]) {
      slotGroups[firstSlot] = [];
    }
    slotGroups[firstSlot].push(p);
  });

  let seq = getNextGroupSequenceByCount(gData, gIdx, language);

  // Process each time slot group
  Object.keys(slotGroups).forEach(slot => {
    const group = slotGroups[slot];
    
    // Skip groups with less than 5 members
    if (group.length < 5) {
      return;
    }
    
    const hasCoordinator = group.some(p => p.data[pIdx.CoordinatorWilling] === true);
    
    // Split large groups into subgroups of 5-8 members
    const subgroups = [];
    let remaining = group.length;
    let index = 0;
    
    while (remaining > 0) {
      if (remaining <= 8) {
        // Last group - take all remaining if >= 5
        if (remaining >= 5) {
          subgroups.push(group.slice(index));
        }
        break;
      } else if (remaining <= 13) {
        // Split into two groups (to avoid creating a group < 5)
        const firstGroupSize = Math.ceil(remaining / 2);
        subgroups.push(group.slice(index, index + firstGroupSize));
        subgroups.push(group.slice(index + firstGroupSize));
        break;
      } else {
        // Take 8 members
        subgroups.push(group.slice(index, index + 8));
        index += 8;
        remaining -= 8;
      }
    }

    // Assign same sequence to all members in each subgroup
    subgroups.forEach(subgroup => {
      const groupName = `NEW → CoC-${language}-${String(seq).padStart(3, "0")} (${slot})`;
      subgroup.forEach(p => {
        pSheet.getRange(p.row, pIdx.SuggestedGroup + 1).setValue(groupName);
      });
      seq++; // Increment for next group
    });
  });
}

/************************************************
 * ACCEPT GROUP SUGGESTIONS
 * - Creates groups
 * - Assigns participants
 * - Computes member count & coordinator
 ************************************************/
function acceptGroupSuggestions() {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  pData.forEach((row, i) => {
    if (row[pIdx.AcceptSuggestion] !== true) return;
    if (!row[pIdx.SuggestedGroup]) return;

    const m = row[pIdx.SuggestedGroup].match(/CoC-[^-]+-\d{3}/);
    if (!m) return;

    const groupName = m[0];

    if (!gData.some(g => g[gIdx.GroupName] === groupName)) {
      const slot = (row[pIdx.SuggestedGroup].match(/\((.*?)\)/) || [])[1] || "TBD";
      const [day, time] = slot.split(" ");

      const newRow = new Array(gHeaders.length).fill("");
      newRow[gIdx.GroupID] = getNextGroupId(gData, gIdx);
      newRow[gIdx.GroupName] = groupName;
      newRow[gIdx.Language] = row[pIdx.Language];
      newRow[gIdx.Day] = day || "";
      newRow[gIdx.Time] = time || "";
      newRow[gIdx.CoordinatorEmail] = "";
      newRow[gIdx.CoordinatorName] = "";
      newRow[gIdx.MemberCount] = 0;
      newRow[gIdx.Status] = "Active";
      if (gIdx.WeeksCompleted !== undefined) newRow[gIdx.WeeksCompleted] = 0;
      if (gIdx.Notes !== undefined) newRow[gIdx.Notes] = "";

      gSheet.appendRow(newRow);
      gData.push(newRow);
    }

    row[pIdx.AssignedGroup] = groupName;
    row[pIdx.AssignmentStatus] = "Assigned";
    row[pIdx.SuggestedGroup] = "";
    row[pIdx.AcceptSuggestion] = false;
    pData[i] = row;
  });

  pSheet.getRange(2, 1, pData.length, pHeaders.length).setValues(pData);

  // Ensure data is written before refresh
  SpreadsheetApp.flush();

  // Immediately recompute derived data
  updateGroupsSheet();
  updateAdminDashboard();
}

/************************************************
 * REFRESH (DERIVED DATA)
 ************************************************/
function refreshGroupsAndDashboard() {
  updateGroupsSheet();
  updateAdminDashboard();
}

/************************************************
 * UPDATE GROUPS (DERIVED FIELDS + CREATE MISSING)
 ************************************************/
function updateGroupsSheet() {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  // Build member map
  const members = {};
  pData.forEach(r => {
    if (!r[pIdx.AssignedGroup]) return;

    if (!members[r[pIdx.AssignedGroup]]) {
      members[r[pIdx.AssignedGroup]] = [];
    }

    members[r[pIdx.AssignedGroup]].push(r);
  });

  // Find existing group names
  const existingGroups = new Set(gData.map(r => r[gIdx.GroupName]).filter(Boolean));

  // Create missing groups
  const newGroups = [];
  Object.keys(members).forEach(groupName => {
    if (!existingGroups.has(groupName)) {
      const firstMember = members[groupName][0];
      const language = firstMember[pIdx.Language];
      
      // Parse day/time from group name or use first member's slot
      let day = "", time = "";
      const slots = splitSlots(firstMember[pIdx.PreferredSlots]);
      if (slots.length > 0) {
        const parts = slots[0].split(" ");
        day = parts[0] || "";
        time = parts[1] || "";
      }

      // Get sequence number from group name
      const seqMatch = groupName.match(/-(\d{3})$/);
      const seq = seqMatch ? parseInt(seqMatch[1], 10) : gData.filter(r => r[gIdx.Language] === language).length + 1;

      const newRow = new Array(gHeaders.length).fill("");
      newRow[gIdx.GroupID] = getNextGroupId(gData, gIdx);
      newRow[gIdx.GroupName] = groupName;
      newRow[gIdx.Language] = language;
      newRow[gIdx.Day] = day;
      newRow[gIdx.Time] = time;
      newRow[gIdx.CoordinatorEmail] = "";
      newRow[gIdx.CoordinatorName] = "";
      newRow[gIdx.MemberCount] = 0;
      newRow[gIdx.Status] = "Active";
      if (gIdx.WeeksCompleted !== undefined) newRow[gIdx.WeeksCompleted] = 0;
      if (gIdx.Notes !== undefined) newRow[gIdx.Notes] = "";

      newGroups.push(newRow);

      existingGroups.add(groupName);
    }
  });

  // Append new groups
  if (newGroups.length > 0) {
    gSheet.getRange(gSheet.getLastRow() + 1, 1, newGroups.length, newGroups[0].length)
      .setValues(newGroups);
    
    // Refresh gData to include new groups
    const updatedGData = gSheet.getDataRange().getValues();
    updatedGData.shift(); // Remove header
    gData.length = 0;
    gData.push(...updatedGData);
  }

  // Update all groups with member count and coordinator
  gData.forEach(r => {
    const m = members[r[gIdx.GroupName]] || [];
    r[gIdx.MemberCount] = m.length;

    // Find coordinator (checkbox can be true, TRUE, or "TRUE")
    const c = m.find(x => {
      const val = x[pIdx.IsGroupCoordinator];
      return val === true || val === "TRUE" || val === "true";
    });
    r[gIdx.CoordinatorName] = c ? c[pIdx.Name] : "";
    r[gIdx.CoordinatorEmail] = c ? c[pIdx.Email] : "";
  });

  gSheet.getRange(2, 1, gData.length, gHeaders.length).setValues(gData);
}

/************************************************
 * ADMIN DASHBOARD
 ************************************************/
function updateAdminDashboard() {
  const ss = SpreadsheetApp.getActive();
  const p = ss.getSheetByName("Participants").getDataRange().getValues();
  const g = ss.getSheetByName("Groups").getDataRange().getValues();
  const d = ss.getSheetByName("AdminDashboard");

  const pH = p.shift();
  const gH = g.shift();
  const pIdx = indexMap(pH);
  const gIdx = indexMap(gH);

  const langs = ["English", "Tamil", "Hindi", "Kannada", "Telugu"];
  const metrics = [
    { key: "TotalGroups", label: "Total Groups" },
    { key: "ActiveGroups", label: "Active Groups" },
    { key: "NoCoordinator", label: "Groups without Coordinator" },
    { key: "Assigned", label: "Assigned Participants" },
    { key: "ActiveParticipants", label: "Active Participants" },
    { key: "Unassigned", label: "Unassigned Participants" }
  ];

  d.getRange(2, 1, 50, 10).clearContent();

  metrics.forEach((m, i) => {
    d.getRange(i + 2, 1).setValue(m.label);
    langs.forEach((l, j) => {
      let v = 0;
      if (m.key === "ActiveParticipants") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.IsActive] === true).length;
      } else if (m.key === "Unassigned") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Unassigned").length;
      } else if (m.key === "Assigned") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Assigned").length;
      } else if (m.key === "TotalGroups") {
        v = g.filter(r => r[gIdx.Language] === l).length;
      } else if (m.key === "ActiveGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Active").length;
      } else if (m.key === "NoCoordinator") {
        v = g.filter(r => r[gIdx.Language] === l && !r[gIdx.CoordinatorEmail]).length;
      }
      d.getRange(i + 2, j + 2).setValue(v);
    });
  });
}

/************************************************
 * HELPERS
 ************************************************/
function indexMap(h) { const m = {}; h.forEach((x, i) => m[String(x).trim()] = i); return m; }
function splitSlots(s) { return String(s || "").split(",").map(x => x.trim()).filter(Boolean); }
function normalizeLanguage(v) {
  const m = { english: "English", tamil: "Tamil", hindi: "Hindi", kannada: "Kannada", telugu: "Telugu" };
  const k = String(v || "").toLowerCase().trim();
  return m[k] || v;
}
function getNextParticipantIdStart(sh, idx) {
  const d = sh.getDataRange().getValues(); let m = 0;
  for (let i = 1; i < d.length; i++) {
    if (/^P-\d+/.test(d[i][idx])) m = Math.max(m, Number(d[i][idx].replace("P-", "")));
  }
  return m + 1;
}
function getNextGroupSequenceByCount(d, idx, l) {
  return d.filter(r => r[idx.Language] === l).length + 1;
}
function getNextGroupId(d, idx) {
  let maxId = 0;
  d.forEach(r => {
    const id = r[idx.GroupID];
    const n = typeof id === "string" && id.match(/G-(\d+)/)
      ? Number(id.replace("G-", ""))
      : 0;
    if (!Number.isNaN(n)) {
      maxId = Math.max(maxId, n);
    }
  });
  return "G-" + String(maxId + 1).padStart(4, "0");
}
function ensureGroupIds(d, idx) {
  if (idx.GroupID === undefined) return;
  let changed = false;
  for (let i = 0; i < d.length; i++) {
    if (!d[i][idx.GroupID]) {
      d[i][idx.GroupID] = getNextGroupId(d, idx);
      changed = true;
    }
  }
  if (changed) {
    const sh = SpreadsheetApp.getActive().getSheetByName("Groups");
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.getRange(2, 1, d.length, headers.length).setValues(d);
  }
}
