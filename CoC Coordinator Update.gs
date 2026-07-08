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

  const { headers: gHeaders, rows: gData } = getCachedGroupsData_();
  const gIdx = indexMap(gHeaders);

  if (gIdx.GroupID === undefined || gIdx.GroupName === undefined || gIdx.Language === undefined) {
    return reject("Groups sheet missing required columns");
  }

  const rows = backfillMissingGroupIds_(gData, gIdx) || gData;

  const payload = rows
    .filter(r => r[gIdx.Language] === language && r[gIdx.Status] !== "Closed" && r[gIdx.Status] !== "Terminated")
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

// Only touches the Groups sheet (and only writes) when a row is actually
// missing a GroupID; on the steady-state path this is a pure in-memory no-op.
function backfillMissingGroupIds_(gData, gIdx) {
  if (gIdx.GroupID === undefined) return null;
  const hasMissing = gData.some(r => !r[gIdx.GroupID]);
  if (!hasMissing) return null;

  const gSheet = getSheet("Groups");
  const ensured = ensureGroupIdsFromRows_(gSheet, gData, gIdx);
  if (ensured) invalidateGroupsCache_();
  return ensured;
}

/**************************************
 * COORDINATOR: GET MEMBERS
 **************************************/
function handleGetGroupMembers(e) {
  verifyRecaptcha(e.parameter.recaptcha);

  const groupName = (e.parameter.GroupName || "").trim();
  if (!groupName) return reject("GroupName is required");

  let cached;
  try {
    cached = getCachedParticipantsMembersData_();
  } catch (err) {
    return reject(err && err.message ? err.message : "Failed to read Participants sheet");
  }

  const { headers, rows: data } = cached;
  if (!headers.length) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: "success", members: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const pIdx = indexMap(headers);

  const members = data
    .filter(r => String(r[pIdx.AssignedGroup] || "").trim().toLowerCase() === groupName.trim().toLowerCase() && (pIdx.AssignmentStatus === undefined || String(r[pIdx.AssignmentStatus] || "").trim() !== "Discontinued"))
    .map(r => ({
      participantID: r[pIdx.ParticipantID],
      name: r[pIdx.Name],
      center: pIdx.Center !== undefined ? (r[pIdx.Center] || "") : "",
      isActive: pIdx.IsActive !== undefined ? toBool(r[pIdx.IsActive]) : true
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
  const scriptTz = Session.getScriptTimeZone();
  const today = (e.parameter.today || "").trim();
  const parsedToday = /^\d{4}-\d{2}-\d{2}$/.test(today) ? new Date(`${today}T00:00:00`) : null;
  const updateDate = parsedToday && !Number.isNaN(parsedToday.getTime()) ? parsedToday : new Date();
  const noteDateText = Utilities.formatDate(updateDate, scriptTz, "yyyy-MM-dd");
  const membersPayload = e.parameter.members;

  if (!groupID || !groupName) return reject("GroupID and GroupName are required");
  if (!status || (status !== "Active" && status !== "Inactive" && status !== "Completed")) {
    return reject("Status must be Active, Inactive, or Completed");
  }

  const weeksCompleted = (status === "Active" || status === "Completed") ? Number(weeksCompletedRaw || 0) : 0;
  if (weeksCompleted < 0 || weeksCompleted > 25 || Number.isNaN(weeksCompleted)) {
    return reject("WeeksCompleted must be between 0 and 25");
  }

  let membersUpdate = {};
  if (membersPayload) {
    try {
      membersUpdate = typeof membersPayload === "string" ? JSON.parse(membersPayload) : membersPayload;
    } catch (err) {
      return reject("Invalid members payload");
    }
  }

  const gSheet = getSheet("Groups");
  const gLastRow = gSheet.getLastRow();
  const gLastCol = gSheet.getLastColumn();
  const gHeaders = gLastRow > 0 ? gSheet.getRange(1, 1, 1, gLastCol).getValues()[0] : [];
  const gIdx = indexMap(gHeaders);

  if (gIdx.GroupID === undefined || gIdx.GroupName === undefined) {
    return reject("Groups sheet missing required columns");
  }

  // Only scan the GroupID column to locate the row, instead of reading the whole sheet.
  const groupIdColValues = gLastRow > 1
    ? gSheet.getRange(2, gIdx.GroupID + 1, gLastRow - 1, 1).getValues()
    : [];
  const groupRowOffset = groupIdColValues.findIndex(r => r[0] === groupID);
  if (groupRowOffset === -1) return reject("Invalid GroupID");
  const groupRowNumber = groupRowOffset + 2;

  const groupRow = gSheet.getRange(groupRowNumber, 1, 1, gLastCol).getValues()[0];
  if (groupRow[gIdx.GroupName] !== groupName) return reject("GroupName mismatch");
  if (coordinatorName && groupRow[gIdx.CoordinatorName]) {
    const storedCoord = String(groupRow[gIdx.CoordinatorName] || "").trim().toLowerCase();
    const submittedCoord = coordinatorName.trim().toLowerCase();
    if (storedCoord && submittedCoord && storedCoord !== submittedCoord) {
      return reject("Coordinator mismatch");
    }
  }

  // Update groups row (in memory; written back to just this row below)
  groupRow[gIdx.Status] = status;
  if (gIdx.WeeksCompleted !== undefined) groupRow[gIdx.WeeksCompleted] = weeksCompleted;
  if (gIdx.Day !== undefined) groupRow[gIdx.Day] = day;
  if (gIdx.Time !== undefined) groupRow[gIdx.Time] = time;
  if (gIdx.Notes !== undefined) {
    const existingNotes = (groupRow[gIdx.Notes] || "").trim();
    const newNote = notes ? `${noteDateText} - ${notes}` : `${noteDateText}`;
    groupRow[gIdx.Notes] = existingNotes ? `${existingNotes}\n${newNote}` : newNote;
  }
  if (gIdx.LastUpdated !== undefined) {
    groupRow[gIdx.LastUpdated] = updateDate;
  }

  const pSheet = getSheet("Participants");
  const pLastRow = pSheet.getLastRow();
  const pLastCol = pSheet.getLastColumn();
  const pHeaders = pLastRow > 0 ? pSheet.getRange(1, 1, 1, pLastCol).getValues()[0] : [];
  const pIdx = indexMap(pHeaders);

  if (pIdx.AssignedGroup === undefined || pIdx.ParticipantID === undefined) {
    return reject("Participants sheet missing required columns");
  }

  let participantsChanged = false;
  let coordinatorPhone = gIdx.CoordinatorWhatsApp !== undefined
    ? String(groupRow[gIdx.CoordinatorWhatsApp] || "").trim()
    : "";
  const needCoordinatorLookup = !coordinatorPhone && pIdx.IsGroupCoordinator !== undefined && pIdx.WhatsApp !== undefined;

  // Read only the columns we need, for all participant rows, and patch just the
  // cells that actually change instead of rewriting the whole Participants sheet.
  if (pLastRow >= 2) {
    const neededCols = [pIdx.AssignedGroup, pIdx.ParticipantID];
    if (pIdx.IsActive !== undefined) neededCols.push(pIdx.IsActive);
    if (needCoordinatorLookup) neededCols.push(pIdx.IsGroupCoordinator, pIdx.WhatsApp);

    const minCol = Math.min.apply(null, neededCols) + 1; // 1-based
    const maxCol = Math.max.apply(null, neededCols) + 1;
    const width = maxCol - minCol + 1;
    const sliceHeaders = pHeaders.slice(minCol - 1, minCol - 1 + width);
    const sliceIdx = indexMap(sliceHeaders);
    const slice = pSheet.getRange(2, minCol, pLastRow - 1, width).getValues();

    const memberUpdates = [];
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const assignedExact = row[sliceIdx.AssignedGroup];

      if (assignedExact === groupName) {
        const pid = row[sliceIdx.ParticipantID];
        if (membersUpdate.hasOwnProperty(pid) && sliceIdx.IsActive !== undefined) {
          memberUpdates.push({ rowNumber: i + 2, col: minCol + sliceIdx.IsActive, value: toBool(membersUpdate[pid]) });
          participantsChanged = true;
        }
      }

      // Fallback: derive coordinator phone from group participants if group row does not have it.
      if (needCoordinatorLookup && !coordinatorPhone) {
        const assignedTrim = String(assignedExact || "").trim().toLowerCase();
        if (assignedTrim === groupName.trim().toLowerCase() && toBool(row[sliceIdx.IsGroupCoordinator])) {
          coordinatorPhone = String(row[sliceIdx.WhatsApp] || "").trim();
        }
      }
    }

    memberUpdates.forEach(u => pSheet.getRange(u.rowNumber, u.col).setValue(u.value));
  }

  gSheet.getRange(groupRowNumber, 1, 1, gLastCol).setValues([groupRow]);
  invalidateGroupsCache_();
  if (participantsChanged) invalidateParticipantsMembersCache_();

  try {
    sendCoordinatorUpdateNotification_({
      groupID: groupID,
      groupName: groupName,
      language: gIdx.Language !== undefined ? String(groupRow[gIdx.Language] || "").trim() : "",
      coordinatorName: gIdx.CoordinatorName !== undefined ? String(groupRow[gIdx.CoordinatorName] || coordinatorName || "").trim() : coordinatorName,
      coordinatorEmail: gIdx.CoordinatorEmail !== undefined ? String(groupRow[gIdx.CoordinatorEmail] || "").trim() : "",
      coordinatorPhone: coordinatorPhone,
      status: status,
      weeksCompleted: weeksCompleted,
      day: day,
      time: time,
      updateDateText: noteDateText,
      notes: notes,
      membersUpdate: membersUpdate
    });
  } catch (err) {
    Logger.log("Coordinator update notification failed: " + (err && err.message ? err.message : err));
  }

  return success();
}

function sendCoordinatorUpdateNotification_(summary) {
  const adminEmail = summary.language ? String(resolveAdminEmailForLanguage(summary.language) || "").trim() : "";
  const coordinatorEmail = String(summary.coordinatorEmail || "").trim();

  const recipients = [adminEmail, coordinatorEmail]
    .filter(Boolean)
    .filter((email, i, arr) => arr.indexOf(email) === i);

  if (recipients.length === 0) return;

  const members = summary.membersUpdate && typeof summary.membersUpdate === "object"
    ? summary.membersUpdate
    : {};

  const memberIds = Object.keys(members);
  const totalMembersSubmitted = memberIds.length;
  const activeSubmitted = memberIds.reduce((count, pid) => count + (toBool(members[pid]) ? 1 : 0), 0);
  const inactiveSubmitted = totalMembersSubmitted - activeSubmitted;

  const subject = `CoC Group Update Submitted: ${summary.groupName} (${summary.status})`;
  const sheetLinks = getParticipantsAndGroupsSheetLinks_();
  const body = buildCoordinatorUpdateEmailBody_({
    groupID: summary.groupID,
    groupName: summary.groupName,
    language: summary.language,
    coordinatorName: summary.coordinatorName,
    coordinatorPhone: summary.coordinatorPhone,
    status: summary.status,
    weeksCompleted: summary.weeksCompleted,
    day: summary.day,
    time: summary.time,
    updateDateText: summary.updateDateText,
    notes: summary.notes,
    totalMembersSubmitted: totalMembersSubmitted,
    activeSubmitted: activeSubmitted,
    inactiveSubmitted: inactiveSubmitted,
    participantsSheetUrl: sheetLinks.participants,
    groupsSheetUrl: sheetLinks.groups
  });

  const emailOptions = {
    to: recipients.join(","),
    subject: subject,
    htmlBody: body
  };

  if (adminEmail) {
    emailOptions.replyTo = adminEmail;
  }

  MailApp.sendEmail(emailOptions);
}

function getParticipantsAndGroupsSheetLinks_() {
  const ss = SpreadsheetApp.getActive();
  if (!ss) return { participants: "", groups: "" };

  const baseUrl = String(ss.getUrl() || "").trim();
  const participantsSheet = ss.getSheetByName("Participants");
  const groupsSheet = ss.getSheetByName("Groups");

  const participants = (baseUrl && participantsSheet)
    ? `${baseUrl}#gid=${participantsSheet.getSheetId()}`
    : "";
  const groups = (baseUrl && groupsSheet)
    ? `${baseUrl}#gid=${groupsSheet.getSheetId()}`
    : "";

  return { participants, groups };
}

function buildCoordinatorUpdateEmailBody_(summary) {
  const weeksText = (summary.status === "Active" || summary.status === "Completed")
    ? String(summary.weeksCompleted)
    : "0";
  const notesText = String(summary.notes || "").trim() || "(No notes provided)";
  const coordinatorPhone = String(summary.coordinatorPhone || "").trim() || "-";
  const participantsLink = String(summary.participantsSheetUrl || "").trim();
  const groupsLink = String(summary.groupsSheetUrl || "").trim();

  return [
    "<div style=\"font-family:Arial,sans-serif;line-height:1.5;color:#222;\">",
    "<p>Hello,</p>",
    "<p>A coordinator status update was submitted for a CoC group.</p>",
    "<p>",
    `<strong>Group:</strong> ${summary.groupName}<br>`,
    `<strong>Group ID:</strong> ${summary.groupID}<br>`,
    `<strong>Language:</strong> ${summary.language || "-"}<br>`,
    `<strong>Coordinator:</strong> ${summary.coordinatorName || "-"}<br>`,
    `<strong>Coordinator WhatsApp:</strong> ${coordinatorPhone}<br>`,
    `<strong>Status:</strong> ${summary.status}<br>`,
    `<strong>Weeks Completed:</strong> ${weeksText}<br>`,
    `<strong>Meeting Day:</strong> ${summary.day || "-"}<br>`,
    `<strong>Meeting Time:</strong> ${summary.time || "-"}<br>`,
    `<strong>Update Date:</strong> ${summary.updateDateText}`,
    "</p>",
    "<p>",
    "<strong>Participant Activity Summary:</strong><br>",
    `• Total members submitted: ${summary.totalMembersSubmitted}<br>`,
    `• Marked active: ${summary.activeSubmitted}<br>`,
    `• Marked inactive: ${summary.inactiveSubmitted}`,
    "</p>",
    "<p>",
    "<strong>Notes:</strong><br>",
    `${notesText}`,
    "</p>",
    "<p>This is an automated notification from the CoC coordinator update workflow.</p>",
    "</div>"
  ].join("");
}

