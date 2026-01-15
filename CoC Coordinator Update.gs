/**************************************
 * COORDINATOR: QUERY GROUPS / MEMBERS / STATUS
 * Separated from participant registration to keep concerns isolated.
 **************************************/
function handleQueryCoordinatorGroups(e) {
  verifyRecaptcha(e.parameter.recaptcha);

  const language = (e.parameter.Language || "").trim();
  const allowedLangs = ["English", "Tamil", "Hindi", "Kannada", "Telugu"];
  if (!allowedLangs.includes(language)) {
    return reject("Invalid language");
  }

  const gSheet = getSheet("Groups");
  const gData = gSheet.getDataRange().getValues();
  const gHeaders = gData.shift();
  const gIdx = indexMap(gHeaders);

  if (gIdx.GroupID === undefined || gIdx.GroupName === undefined || gIdx.Language === undefined) {
    return reject("Groups sheet missing required columns");
  }

  const ensured = ensureGroupIds(gSheet, gData, gIdx);
  const rows = ensured || gData;

  const payload = rows
    .filter(r => r[gIdx.Language] === language)
    .map(r => ({
      groupID: r[gIdx.GroupID],
      groupName: r[gIdx.GroupName],
      coordinatorName: r[gIdx.CoordinatorName] || "",
      status: r[gIdx.Status] || "",
      weeksCompleted: Number(r[gIdx.WeeksCompleted] || 0),
      day: gIdx.Day !== undefined ? String(r[gIdx.Day] || "").trim() : "",
      time: gIdx.Time !== undefined ? String(r[gIdx.Time] || "").trim() : ""
    }));

  return ContentService
    .createTextOutput(JSON.stringify({ result: "success", groups: payload }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**************************************
 * COORDINATOR: GET MEMBERS
 **************************************/
function handleGetGroupMembers(e) {
  verifyRecaptcha(e.parameter.recaptcha);

  const groupName = (e.parameter.GroupName || "").trim();
  if (!groupName) return reject("GroupName is required");

  const pSheet = getSheet("Participants");
  const pData = pSheet.getDataRange().getValues();
  const pHeaders = pData.shift();
  const pIdx = indexMap(pHeaders);

  if (pIdx.AssignedGroup === undefined || pIdx.ParticipantID === undefined || pIdx.Name === undefined) {
    return reject("Participants sheet missing required columns");
  }

  const members = pData
    .filter(r => r[pIdx.AssignedGroup] === groupName)
    .map(r => ({
      participantID: r[pIdx.ParticipantID],
      name: r[pIdx.Name],
      center: pIdx.Center !== undefined ? (r[pIdx.Center] || "") : "",
      isActive: toBool(r[pIdx.IsActive])
    }));

  return ContentService
    .createTextOutput(JSON.stringify({ result: "success", members }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**************************************
 * COORDINATOR: UPDATE GROUP STATUS
 **************************************/
function handleUpdateGroupStatus(e) {
  verifyRecaptcha(e.parameter.recaptcha);

  const groupID = (e.parameter.groupID || "").trim();
  const groupName = (e.parameter.groupName || "").trim();
  const coordinatorName = (e.parameter.coordinatorName || "").trim();
  const status = (e.parameter.status || "").trim();
  const weeksCompletedRaw = e.parameter.weeksCompleted;
  const day = (e.parameter.day || "").trim();
  const time = (e.parameter.time || "").trim();
  const notes = (e.parameter.notes || "").trim();
  const today = e.parameter.today || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const membersPayload = e.parameter.members;

  if (!groupID || !groupName) return reject("GroupID and GroupName are required");
  if (!status || (status !== "Active" && status !== "Inactive" && status !== "Completed")) {
    return reject("Status must be Active, Inactive, or Completed");
  }

  const weeksCompleted = (status === "Active" || status === "Completed") ? Number(weeksCompletedRaw || 0) : 0;
  if (weeksCompleted < 0 || weeksCompleted > 20 || Number.isNaN(weeksCompleted)) {
    return reject("WeeksCompleted must be between 0 and 20");
  }

  let membersUpdate = {};
  if (membersPayload) {
    try {
      membersUpdate = typeof membersPayload === "string" ? JSON.parse(membersPayload) : membersPayload;
    } catch (err) {
      return reject("Invalid members payload");
    }
  }

  const ss = SpreadsheetApp.getActive();
  const gSheet = getSheet("Groups");
  const gData = gSheet.getDataRange().getValues();
  const gHeaders = gData.shift();
  const gIdx = indexMap(gHeaders);

  if (gIdx.GroupID === undefined || gIdx.GroupName === undefined) {
    return reject("Groups sheet missing required columns");
  }

  const pSheet = getSheet("Participants");
  const pData = pSheet.getDataRange().getValues();
  const pHeaders = pData.shift();
  const pIdx = indexMap(pHeaders);

  const groupRowIndex = gData.findIndex(r => r[gIdx.GroupID] === groupID);
  if (groupRowIndex === -1) return reject("Invalid GroupID");

  const groupRow = gData[groupRowIndex];
  if (groupRow[gIdx.GroupName] !== groupName) return reject("GroupName mismatch");
  if (coordinatorName && groupRow[gIdx.CoordinatorName]) {
    const storedCoord = String(groupRow[gIdx.CoordinatorName] || "").trim().toLowerCase();
    const submittedCoord = coordinatorName.trim().toLowerCase();
    if (storedCoord && submittedCoord && storedCoord !== submittedCoord) {
      return reject("Coordinator mismatch");
    }
  }

  // Update groups row
  groupRow[gIdx.Status] = status;
  if (gIdx.WeeksCompleted !== undefined) groupRow[gIdx.WeeksCompleted] = weeksCompleted;
  if (gIdx.Day !== undefined) groupRow[gIdx.Day] = day;
  if (gIdx.Time !== undefined) groupRow[gIdx.Time] = time;
  if (gIdx.Notes !== undefined) {
    const existingNotes = (groupRow[gIdx.Notes] || "").trim();
    const newNote = notes ? `${today} - ${notes}` : `${today}`;
    groupRow[gIdx.Notes] = existingNotes ? `${existingNotes}\n${newNote}` : newNote;
  }
  gData[groupRowIndex] = groupRow;

  // Update participant activity
  if (pIdx.AssignedGroup === undefined || pIdx.ParticipantID === undefined) {
    return reject("Participants sheet missing required columns");
  }

  let participantsChanged = false;
  pData.forEach((row, i) => {
    if (row[pIdx.AssignedGroup] !== groupName) return;
    const pid = row[pIdx.ParticipantID];
    if (membersUpdate.hasOwnProperty(pid)) {
      row[pIdx.IsActive] = toBool(membersUpdate[pid]);
      pData[i] = row;
      participantsChanged = true;
    }
  });

  gSheet.getRange(2, 1, gData.length, gHeaders.length).setValues(gData);
  if (participantsChanged) {
    pSheet.getRange(2, 1, pData.length, pHeaders.length).setValues(pData);
  }

  return success();
}
