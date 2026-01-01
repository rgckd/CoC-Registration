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
 * MAIN ENTRY POINT
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

    /************* reCAPTCHA *************/
    const token = e.parameter.recaptcha;
    if (!token) {
      return reject("Captcha missing");
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
      return reject("Captcha verification failed");
    }

    /************* NORMALIZE INPUT *************/
    const data = normalizeRequest(e);

    const missing = validateSubmission(data);
  
    /************* VALIDATION (SINGLE SOURCE OF TRUTH) *************/
    if (missing.length > 0) {
      return ContentService
        .createTextOutput(JSON.stringify({
          result: "error",
          error: "Missing required field(s)"+missing,
          missing: missing
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }


    if (!/^[6-9]\d{9}$/.test(data.WhatsApp)) {
      return reject("Invalid phone number");
    }

    /************* WRITE TO SHEET *************/
    const sheet = SpreadsheetApp
      .getActive()
      .getSheetByName(SHEET_NAME);

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

    /************* EMAIL CONFIRMATION *************/
    const emailBody = buildConfirmationEmail(data);

    MailApp.sendEmail({
      to: data.Email,
      subject: "CoC Registration Confirmation",
      htmlBody: emailBody
    });

    return success();

  } catch (err) {
    Logger.log(err);
    return reject("Server error");
  }
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
