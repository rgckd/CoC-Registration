/**************************************
 * CONFIGURATION
 **************************************/
const SHEET_NAME = "CustomForm";
const MIN_SCORE = 0.5;

/**************************************
 * SECRET ACCESS
 **************************************/
function getRecaptchaSecret() {
  const secret = PropertiesService
    .getScriptProperties()
    .getProperty("RECAPTCHA_SECRET");

  if (!secret) {
    throw new Error("reCAPTCHA secret not set in Script Properties");
  }
  return secret;
}

/**************************************
 * MAIN ENTRY POINT (ACTION DISPATCHER)
 **************************************/
function doPost(e) {
  try {
    if (!e || !e.parameter) {
      return reject("Invalid request");
    }

    // Honeypot
    if (e.parameter.honey) {
      return reject("Spam detected");
    }

    const action = e.parameter.action || "register";

    switch (action) {
      case "register":
        return handleRegistration(e);
      case "queryCoordinatorGroups":
        return handleQueryCoordinatorGroups(e);
      case "getGroupMembers":
        return handleGetGroupMembers(e);
      case "updateGroupStatus":
        return handleUpdateGroupStatus(e);
      default:
        return reject("Unknown action");
    }

  } catch (err) {
    Logger.log(err);
    return reject(err && err.message ? err.message : "Server error");
  }
}

/**************************************
 * REGISTRATION (EXISTING FLOW)
 **************************************/
function handleRegistration(e) {
  verifyRecaptcha(e.parameter.recaptcha);

  const data = normalizeRequest(e);
  const missing = validateSubmission(data);

  if (missing.length > 0) {
    return ContentService
      .createTextOutput(JSON.stringify({
        result: "error",
        error: "Missing required field(s)" + missing,
        missing: missing
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (!/^[6-9]\d{9}$/.test(data.WhatsApp)) {
    return reject("Invalid phone number");
  }

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) {
    return reject("Sheet not found");
  }

  sheet.appendRow([
    new Date(),           // Timestamp
    data.Email,           // Email
    data.Name,            // Name
    data.WhatsApp,        // WhatsApp
    data.Center,          // Center
    data.EnglishAbility || "Yes",  // EnglishProficiency
    data.Times.join(", "),         // PreferredTimes
    data.Coordinator,     // Coordinator
    data.Language         // Language
  ]);

  const emailBody = buildConfirmationEmail(data);

  MailApp.sendEmail({
    to: data.Email,
    subject: "CoC Registration Confirmation",
    htmlBody: emailBody
  });

  return success();
}

/**************************************
 * COORDINATOR: QUERY GROUPS
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
      weeksCompleted: Number(r[gIdx.WeeksCompleted] || 0)
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
  const notes = (e.parameter.notes || "").trim();
  const today = e.parameter.today || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const membersPayload = e.parameter.members;

  if (!groupID || !groupName) return reject("GroupID and GroupName are required");
  if (!status || (status !== "Active" && status !== "Inactive")) {
    return reject("Status must be Active or Inactive");
  }

  const weeksCompleted = status === "Active" ? Number(weeksCompletedRaw || 0) : 0;
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

/**************************************
 * NORMALIZATION
 **************************************/
function normalizeRequest(e) {
  return {
    Email: (e.parameter.Email || "").trim(),
    Name: sanitize(e.parameter.Name),
    WhatsApp: (e.parameter.WhatsApp || "").replace(/\D/g, ""),
    Center: sanitize(e.parameter.Center),
    Coordinator: sanitize(e.parameter.Coordinator || ""),
    Language: e.parameter.Language || "English",
    EnglishAbility: sanitize(e.parameter.EnglishAbility || ""),
    Times: e.parameters && e.parameters.Times
      ? [].concat(e.parameters.Times)
      : []
  };
}

/**************************************
 * VALIDATION (AUTHORITATIVE)
 **************************************/
function validateSubmission(data) {
  const missing = [];

  if (!data.Email) missing.push("Email");
  if (!data.Name) missing.push("Name");
  if (!data.WhatsApp) missing.push("WhatsApp");
  if (!data.Center) missing.push("Center");
  if (!data.Coordinator) missing.push("Coordinator");

  if (!Array.isArray(data.Times) || data.Times.length === 0) {
    missing.push("Preferred days & times");
  }

  if (data.Language !== "English") {
    if (data.EnglishAbility !== "Yes") {
      missing.push("Do you know English?");
    }
  }

  return missing;
}

/**************************************
 * EMAIL BUILDER
 **************************************/
function buildConfirmationEmail(data) {
  const labels = {
    English: {
      title: "Thank you for registering for CoC",
      summary: "Here are the details you submitted:",
      name: "Name",
      email: "Email",
      phone: "WhatsApp",
      center: "Center",
      times: "Preferred days & times",
      coordinator: "Willing to be a coordinator",
      footer: "We will contact you soon."
    },
    Tamil: {
      title: "CoC பதிவு செய்ததற்கு நன்றி",
      summary: "நீங்கள் அளித்த விவரங்கள்:",
      name: "பெயர்",
      email: "மின்னஞ்சல்",
      phone: "வாட்ஸாப்ப்",
      center: "மையம்",
      times: "விருப்பமான நாட்கள் & நேரங்கள்",
      coordinator: "ஒருங்கிணைப்பாளராக இருக்க தயாரா",
      footer: "விரைவில் உங்களை தொடர்பு கொள்வோம்."
    },
    Hindi: {
      title: "CoC पंजीकरण के लिए धन्यवाद",
      summary: "आपके द्वारा दी गई जानकारी:",
      name: "नाम",
      email: "ईमेल",
      phone: "व्हाट्सएप",
      center: "केंद्र",
      times: "पसंदीदा दिन और समय",
      coordinator: "समन्वयक बनने की इच्छा",
      footer: "हम जल्द ही आपसे संपर्क करेंगे।"
    },
    Kannada: {
      title: "CoC ನೋಂದಣಿಗೆ ಧನ್ಯವಾದಗಳು",
      summary: "ನೀವು ನೀಡಿದ ವಿವರಗಳು:",
      name: "ಹೆಸರು",
      email: "ಇಮೇಲ್",
      phone: "ವಾಟ್ಸಾಪ್",
      center: "ಕೇಂದ್ರ",
      times: "ಆದ್ಯತೆಯ ದಿನಗಳು ಮತ್ತು ಸಮಯಗಳು",
      coordinator: "ಸಂಯೋಜಕರಾಗಲು ಇಚ್ಛೆ",
      footer: "ನಾವು ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತೇವೆ."
    },
    Telugu: {
      title: "CoC నమోదు చేసినందుకు ధన్యవాదాలు",
      summary: "మీరు సమర్పించిన వివరాలు:",
      name: "పేరు",
      email: "ఇమెయిల్",
      phone: "వాట్సాప్",
      center: "కేంద్రం",
      times: "ఇష్టమైన రోజులు & సమయాలు",
      coordinator: "సమన్వయకర్తగా ఉండాలా",
      footer: "మేము త్వరలో మిమ్మల్ని సంప్రదిస్తాము."
    }
  };

  const t = labels[data.Language] || labels.English;
  const timesHtml = data.Times.map(t => `<li>${t}</li>`).join("");

  return `
    <p>🙏 <strong>${t.title}</strong></p>
    <p>${t.summary}</p>
    <p><strong>${t.name}:</strong> ${data.Name}</p>
    <p><strong>${t.email}:</strong> ${data.Email}</p>
    <p><strong>${t.phone}:</strong> ${data.WhatsApp}</p>
    <p><strong>${t.center}:</strong> ${data.Center}</p>
    <p><strong>${t.times}:</strong></p>
    <ul>${timesHtml}</ul>
    <p><strong>${t.coordinator}:</strong> ${data.Coordinator}</p>
    <p>${t.footer}</p>
  `;
}

/**************************************
 * HELPERS
 **************************************/
function verifyRecaptcha(token) {
  if (!token) {
    throw new Error("Captcha missing");
  }

  const captchaRes = UrlFetchApp.fetch(
    "https://www.google.com/recaptcha/api/siteverify",
    {
      method: "post",
      payload: {
        secret: getRecaptchaSecret(),
        response: token
      }
    }
  );

  const captcha = JSON.parse(captchaRes.getContentText());
  if (!captcha.success || captcha.score < MIN_SCORE) {
    throw new Error("Captcha verification failed");
  }
}

function getSheet(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) {
    throw new Error(`Sheet not found: ${name}`);
  }
  return sh;
}

function indexMap(h) {
  const m = {};
  h.forEach((x, i) => m[String(x).trim()] = i);
  return m;
}

function ensureGroupIds(gSheet, gData, gIdx) {
  if (gIdx.GroupID === undefined) return null;

  let maxId = 0;
  gData.forEach(r => {
    const id = r[gIdx.GroupID];
    const n = typeof id === "string" && id.match(/G-(\d+)/)
      ? Number(id.replace("G-", ""))
      : 0;
    if (!Number.isNaN(n)) {
      maxId = Math.max(maxId, n);
    }
  });

  let changed = false;
  gData.forEach((r, i) => {
    if (!r[gIdx.GroupID]) {
      maxId += 1;
      r[gIdx.GroupID] = "G-" + String(maxId).padStart(4, "0");
      gData[i] = r;
      changed = true;
    }
  });

  if (changed) {
    const gHeaders = gSheet.getRange(1, 1, 1, gSheet.getLastColumn()).getValues()[0];
    gSheet.getRange(2, 1, gData.length, gHeaders.length).setValues(gData);
    return gData;
  }

  return null;
}

function toBool(val) {
  return val === true || val === "TRUE" || val === "true" || val === 1 || val === "1";
}

function sanitize(val) {
  return String(val || "").replace(/[<>]/g, "").trim();
}

function success() {
  return ContentService
    .createTextOutput(JSON.stringify({ result: "success" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function reject(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ result: "error", error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
