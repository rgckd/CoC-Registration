const translations = {
  English: {
    email: "Email *",
    name: "Your Name *",
    whatsapp: "WhatsApp Number *",
    center: "Your Heartfulness Center *",
    english: "Do you know English? *",
    preferredDaysAndTimes: "Preferred days & times *",
    coordinator: "Willing to be a coordinator? *",
    morning: "Morning (9am – noon)",
    afternoon: "Afternoon (noon – 5pm)",
    evening: "Evening (5pm – 9pm)"
  },
  Tamil: {
    email: "மின்னஞ்சல் *",
    name: "உங்கள் பெயர் *",
    whatsapp: "வாட்ஸ்அப் எண் *",
    center: "உங்கள் ஹார்ட்ஃபுல்னெஸ் சென்டர் *",
    english: "உங்களுக்கு ஆங்கிலம் தெரியுமா? *",
    preferredDaysAndTimes: "விரும்பிய நாட்கள் மற்றும் நேரங்கள் *",
    coordinator: "உங்கள் குழுவின் ஒருங்கிணைப்பாளராக இருக்க தயாரா? *",
    morning: "காலை (9am – 12pm)",
    afternoon: "பிற்பகல் (12pm – 5pm)",
    evening: "மாலை (5pm – 9pm)"
  },
  Hindi: {
    email: "ईमेल *",
    name: "आपका नाम *",
    whatsapp: "व्हाट्सएप नंबर *",
    center: "आपका Heartfulness केंद्र *",
    english: "क्या आपको अंग्रेज़ी आती है? *",
    preferredDaysAndTimes: "पसंदीदा दिन और समय *",
    coordinator: "क्या आप एक समन्वयक बनना चाहते हैं? *",
    morning: "सुबह (9am – 12pm)",
    afternoon: "दोपहर (12pm – 5pm)",
    evening: "शाम (5pm – 9pm)"
  },
  Kannada: {
    email: "ಇಮೇಲ್ *",
    name: "ನಿಮ್ಮ ಹೆಸರು *",
    whatsapp: "ವಾಟ್ಸ್ಅಪ್ ಸಂಖ್ಯೆ *",
    center: "ನಿಮ್ಮ Heartfulness ಕೇಂದ್ರ *",
    english: "ನೀವು ಇಂಗ್ಲಿಷ್ ತಿಳಿದಿದ್ದೀರಾ? *",
    preferredDaysAndTimes: "ಆದ್ಯತೆಯ ದಿನಗಳು ಮತ್ತು ಸಮಯಗಳು *",
    coordinator: "ನೀವು ಸಮನ್ವಯಕರಾಗಲು ಬಯಸುತ್ತೀರಾ? *",
    morning: "ಬೆಳಗಿನ (9am – 12pm)",
    afternoon: "ಮಧ್ಯಾಹ್ನ (12pm – 5pm)",
    evening: "ಸಂಜೆ (5pm – 9pm)"
  },
  Telugu: {
    email: "ఈమెయిల్ *",
    name: "మీ పేరు *",
    whatsapp: "WhatsApp నంబర్ *",
    center: "మీ Heartfulness కేంద్రం *",
    english: "మీకు ఆంగ్లం తెలుసా? *",
    preferredDaysAndTimes: "ఇష్టమైన రోజులు మరియు సమయాలు *",
    coordinator: "మీరు సమన్వయకారిగా ఉండాలనుకుంటున్నారా? *",
    morning: "ఉదయం (9am – 12pm)",
    afternoon: "మధ్యాహ్నం (12pm – 5pm)",
    evening: "సాయంత్రం (5pm – 9pm)"
  }
};

function applyLanguage(lang) {
  const dict = translations[lang];
  document.querySelectorAll("[data-i18n]").forEach(el => {
    if (dict && dict[el.dataset.i18n]) {
      el.textContent = dict[el.dataset.i18n];
    }
  });
}
