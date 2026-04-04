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

/**************************************
 * COORDINATOR: GET MEMBERS
 **************************************/
function handleGetGroupMembers(e) {
  verifyRecaptcha(e.parameter.recaptcha);

  const groupName = (e.parameter.GroupName || "").trim();
  if (!groupName) return reject("GroupName is required");

  const pSheet = getSheet("Participants");
  const lastRow = pSheet.getLastRow();
  const lastCol = pSheet.getLastColumn();
  if (lastRow < 2) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: "success", members: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Read headers once, then fetch only the column slice we need
  const fullHeaders = pSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idxFull = indexMap(fullHeaders);
  const required = ["AssignedGroup", "ParticipantID", "Name"];
  for (const k of required) {
    if (idxFull[k] === undefined) return reject("Participants sheet missing required columns");
  }

  const optional = ["Center", "IsActive", "AssignmentStatus"];
  const colsNeeded = required.concat(optional)
    .map(k => idxFull[k])
    .filter(v => v !== undefined);

  const minCol = Math.min.apply(null, colsNeeded) + 1; // 1-based
  const maxCol = Math.max.apply(null, colsNeeded) + 1;
  const width = maxCol - minCol + 1;

  const headers = fullHeaders.slice(minCol - 1, minCol - 1 + width);
  const pIdx = indexMap(headers);

  const data = pSheet.getRange(2, minCol, lastRow - 1, width).getValues();

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
    const newNote = notes ? `${noteDateText} - ${notes}` : `${noteDateText}`;
    groupRow[gIdx.Notes] = existingNotes ? `${existingNotes}\n${newNote}` : newNote;
  }
  if (gIdx.LastUpdated !== undefined) {
    groupRow[gIdx.LastUpdated] = updateDate;
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

  try {
    let coordinatorPhone = gIdx.CoordinatorWhatsApp !== undefined
      ? String(groupRow[gIdx.CoordinatorWhatsApp] || "").trim()
      : "";

    // Fallback: derive coordinator phone from group participants if group row does not have it.
    if (!coordinatorPhone && pIdx.IsGroupCoordinator !== undefined && pIdx.WhatsApp !== undefined) {
      const coordinatorMember = pData.find(row => {
        const assigned = String(row[pIdx.AssignedGroup] || "").trim().toLowerCase();
        return assigned === groupName.trim().toLowerCase() && toBool(row[pIdx.IsGroupCoordinator]);
      });
      if (coordinatorMember) {
        coordinatorPhone = String(coordinatorMember[pIdx.WhatsApp] || "").trim();
      }
    }

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
    "<p>",
    "<strong>Reference Sheets:</strong><br>",
    participantsLink ? `• <a href=\"${participantsLink}\">CoC Participants Sheet</a><br>` : "",
    groupsLink ? `• <a href=\"${groupsLink}\">CoC Groups Sheet</a>` : "",
    (!participantsLink && !groupsLink) ? "(Participants/Groups sheet links unavailable)" : "",
    "</p>",
    "<p>This is an automated notification from the CoC coordinator update workflow.</p>",
    "</div>"
  ].join("");
}

