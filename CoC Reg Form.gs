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

  // Allow international numbers: 8–15 digits after stripping symbols (E.164 length range)
  if (!/^\d{8,15}$/.test(data.WhatsApp)) {
    return reject("Invalid phone number (enter 8-15 digits, include country code)");
  }

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) {
    return reject("Sheet not found");
  }

  // Check for duplicate submission within 5 minutes (prevent accidental double-click)
  const isDuplicate = checkRecentDuplicate(sheet, data.Email);
  
  // Append the submission regardless (maintain append-only log)
  sheet.appendRow([
    new Date(),           // Timestamp
    data.Language,        // Language
    data.Email,           // Email
    data.Name,            // Name
    data.WhatsApp,        // WhatsApp
    data.Center,          // Center
    data.EnglishAbility || "Yes",  // EnglishProficiency
    data.Times.join(", "),         // PreferredTimes
    data.Coordinator,     // Coordinator
    "",                   // Processed (empty for new rows)
    data.Comments || "",  // Comments
    data.DisclaimerConsent || "No" // Disclaimer Consent
  ]);

  // Only send confirmation email if not a duplicate
  if (!isDuplicate) {
    const emailBody = buildConfirmationEmail(data);

    MailApp.sendEmail({
      to: data.Email,
      subject: "CoC Registration Confirmation",
      htmlBody: emailBody
    });
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
    Comments: sanitize(e.parameter.Comments || ""),
    DisclaimerConsent: e.parameter.DisclaimerConsent === "on" ? "Yes" : "No",
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
  if (data.DisclaimerConsent !== "Yes") missing.push("Disclaimer Consent");

  if (!Array.isArray(data.Times) || data.Times.length === 0) {
    missing.push("Preferred days & times");
  }

  if (data.Language !== "English") {
    if (!data.EnglishAbility) {
      missing.push("Do you know English?");
    }
  }

  return missing;
}

/**************************************
 * DUPLICATE SUBMISSION DETECTION
 **************************************/
function checkRecentDuplicate(sheet, email) {
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const emailColIndex = headers.indexOf("Email");
  const timestampColIndex = headers.indexOf("Timestamp");
  
  if (emailColIndex === -1 || timestampColIndex === -1) {
    return false; // Can't check without these columns
  }
  
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  
  // Check the last 10 rows for performance (recent duplicates would be near the end)
  for (let i = Math.max(1, data.length - 10); i < data.length; i++) {
    const rowEmail = String(data[i][emailColIndex] || "").trim();
    const rowTimestamp = data[i][timestampColIndex];
    
    if (rowEmail === email && rowTimestamp instanceof Date) {
      if (rowTimestamp >= fiveMinutesAgo) {
        // Found a submission from the same email within 5 minutes
        return true;
      }
    }
  }
  
  return false;
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
      english: "English proficiency",
      times: "Preferred days & times",
      coordinator: "Willing to be a coordinator",
      comments: "Comments",
      overviewIntro: "Please go through this link to learn more about CoC:",
      disclaimerFull: "You agreed to: I have read and agree to the <a href=\"https://www.hcessentials.org/disclaimer\" target=\"_blank\">Event Disclaimer and Social Media Policy</a>, including the terms at <a href=\"https://heartfulness.org/us/terms\" target=\"_blank\">heartfulness.org/us/terms</a>. I confirm that I am at least 18 years of age and consent to recordings being made of this program.",
      footer: "We will contact you soon."
    },
    Tamil: {
      title: "CoC பதிவு செய்ததற்கு நன்றி",
      summary: "நீங்கள் அளித்த விவரங்கள்:",
      name: "பெயர்",
      email: "மின்னஞ்சல்",
      phone: "வாட்ஸாப்ப்",
      center: "மையம்",
      english: "ஆங்கிலம் தெரியுமா",
      times: "விருப்பமான நாட்கள் & நேரங்கள்",
      coordinator: "ஒருங்கிணைப்பாளராக இருக்க தயாரா",
      comments: "கருத்துக்கள்",
      overviewIntro: "CoC பற்றி மேலும் அறிய இந்த இணைப்பைப் பார்க்கவும்:",
      disclaimerFull: "நான் <a href=\"https://www.hcessentials.org/disclaimer\" target=\"_blank\">Event Disclaimer and Social Media Policy</a> மற்றும் <a href=\"https://heartfulness.org/us/terms\" target=\"_blank\">heartfulness.org/us/terms</a> இல் உள்ள விதிமுறைகளை படித்து ஒப்புக்கொள்கிறேன். நான் குறைந்தது 18 வயது நிரம்பியவர் என்பதை உறுதிப்படுத்துகிறேன் மற்றும் இந்த நிகழ்ச்சியின் பதிவுகள் செய்யப்படுவதற்கு சம்மதிக்கிறேன்.",
      footer: "விரைவில் உங்களை தொடர்பு கொள்வோம்."
    },
    Hindi: {
      title: "CoC पंजीकरण के लिए धन्यवाद",
      summary: "आपके द्वारा दी गई जानकारी:",
      name: "नाम",
      email: "ईमेल",
      phone: "व्हाट्सएप",
      center: "केंद्र",
      english: "अंग्रेज़ी का ज्ञान",
      times: "पसंदीदा दिन और समय",
      coordinator: "समन्वयक बनने की इच्छा",
      comments: "टिप्पणियाँ",
      overviewIntro: "CoC के बारे में अधिक जानने के लिए इस लिंक को देखें:",
      disclaimerFull: "मैंने <a href=\"https://www.hcessentials.org/disclaimer\" target=\"_blank\">Event Disclaimer and Social Media Policy</a> और <a href=\"https://heartfulness.org/us/terms\" target=\"_blank\">heartfulness.org/us/terms</a> पर दी गई शर्तों को पढ़ लिया है और सहमत हूं। मैं पुष्टि करता/करती हूं कि मैं कम से कम 18 वर्ष का/की हूं और इस कार्यक्रम की रिकॉर्डिंग के लिए सहमति देता/देती हूं।",
      footer: "हम जल्द ही आपसे संपर्क करेंगे।"
    },
    Kannada: {
      title: "CoC ನೋಂದಣಿಗೆ ಧನ್ಯವಾದಗಳು",
      summary: "ನೀವು ನೀಡಿದ ವಿವರಗಳು:",
      name: "ಹೆಸರು",
      email: "ಇಮೇಲ್",
      phone: "ವಾಟ್ಸಾಪ್",
      center: "ಕೇಂದ್ರ",
      english: "ಇಂಗ್ಲಿಷ್ ಜ್ಞಾನ",
      times: "ಆದ್ಯತೆಯ ದಿನಗಳು ಮತ್ತು ಸಮಯಗಳು",
      coordinator: "ಸಂಯೋಜಕರಾಗಲು ಇಚ್ಛೆ",
      comments: "ಅಭಿಪ್ರಾಯಗಳು",
      overviewIntro: "CoC ಬಗ್ಗೆ ಹೆಚ್ಚು ತಿಳಿಯಲು ಈ ಲಿಂಕ್ ನೋಡಿ:",
      disclaimerFull: "ನಾನು <a href=\"https://www.hcessentials.org/disclaimer\" target=\"_blank\">Event Disclaimer and Social Media Policy</a> ಮತ್ತು <a href=\"https://heartfulness.org/us/terms\" target=\"_blank\">heartfulness.org/us/terms</a> ನಲ್ಲಿನ ನಿಯಮಗಳನ್ನು ಓದಿದ್ದೇನೆ ಮತ್ತು ಒಪ್ಪುತ್ತೇನೆ. ನಾನು ಕನಿಷ್ಠ 18 ವರ್ಷ ವಯಸ್ಸನ್ನು ತಲುಪಿದ್ದೇನೆ ಎಂದು ದೃಢೀಕರಿಸುತ್ತೇನೆ ಮತ್ತು ಈ ಕಾರ್ಯಕ್ರಮದ ರೆಕಾರ್ಡಿಂಗ್‌ಗಳನ್ನು ಮಾಡಲು ಒಪ್ಪುತ್ತೇನೆ.",
      footer: "ನಾವು ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತೇವೆ."
    },
    Telugu: {
      title: "CoC నమోదు చేసినందుకు ధన్యవాదాలు",
      summary: "మీరు సమర్పించిన వివరాలు:",
      name: "పేరు",
      email: "ఇమెయిల్",
      phone: "వాట్సాప్",
      center: "కేంద్రం",
      english: "ఆంగ్ల పరిజ్ఞానం",
      times: "ఇష్టమైన రోజులు & సమయాలు",
      coordinator: "సమన్వయకర్తగా ఉండాలా",
      comments: "వ్యాఖ్యలు",
      overviewIntro: "CoC గురించి మరింత తెలుసుకోవడానికి ఈ లింక్ చూడండి:",
      disclaimerFull: "నేను <a href=\"https://www.hcessentials.org/disclaimer\" target=\"_blank\">Event Disclaimer and Social Media Policy</a> మరియు <a href=\"https://heartfulness.org/us/terms\" target=\"_blank\">heartfulness.org/us/terms</a> వద్ద ఉన్న నిబంధనలను చదివాను మరియు అంగీకరిస్తున్నాను. నేను కనీసం 18 సంవత్సరాల వయస్సు కలిగి ఉన్నానని నిర్ధారిస్తున్నాను మరియు ఈ కార్యక్రమం యొక్క రికార్డింగ్‌లు చేయడానికి అంగీకరిస్తున్నాను.",
      footer: "మేము త్వరలో మిమ్మల్ని సంప్రదిస్తాము."
    }
  };

  const t = labels[data.Language] || labels.English;
  const links = typeof getMasterResourceLinks === "function" ? getMasterResourceLinks(data.Language) : {};
  const timesHtml = data.Times.map(t => `<li>${t}</li>`).join("");
  const englishAbility = data.Language !== "English" && data.EnglishAbility ? `<p><strong>${t.english}:</strong> ${data.EnglishAbility}</p>` : "";
  const comments = data.Comments ? `<p><strong>${t.comments}:</strong> ${data.Comments}</p>` : "";
  const disclaimerLine = data.DisclaimerConsent === "Yes" ? `<p>${t.disclaimerFull}</p>` : "";
  const overviewLine = links.overview ? `<p>${t.overviewIntro} <a href="${links.overview}">${links.overview}</a></p>` : "";

  return `
    <p>🙏 <strong>${t.title}</strong></p>
    <p>${t.summary}</p>
    <p><strong>${t.name}:</strong> ${data.Name}</p>
    <p><strong>${t.email}:</strong> ${data.Email}</p>
    <p><strong>${t.phone}:</strong> ${data.WhatsApp}</p>
    <p><strong>${t.center}:</strong> ${data.Center}</p>
    ${englishAbility}
    <p><strong>${t.times}:</strong></p>
    <ul>${timesHtml}</ul>
    <p><strong>${t.coordinator}:</strong> ${data.Coordinator}</p>
    ${comments}
    ${overviewLine}
    <p>${t.footer}</p>
    ${disclaimerLine}
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
