const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cors());

const upload = multer({ dest: 'uploads/' });

const translationsFilePath = path.join(__dirname, 'translations.json');

// Load translations from the file on server startup
let translations = loadTranslations();

// Function to load translations from a JSON file
function loadTranslations() {
  if (fs.existsSync(translationsFilePath)) {
    return JSON.parse(fs.readFileSync(translationsFilePath, 'utf8'));
  } else {
    return {
      data: []
    };
  }
}

// Function to save translations to a JSON file
function saveTranslations() {
  fs.writeFileSync(translationsFilePath, JSON.stringify(translations, null, 2));
}

// Get all translations
app.get('/api/translations', (req, res) => {
  res.json(translations);
});

// Get translation by key
app.get('/api/translation/:key', (req, res) => {
  const key = req.params.key;
  const translation = translations.data.find(item => item.key === key);
  if (translation) {
    res.json(translation);
  } else {
    res.status(404).json({ error: "Key not found" });
  }
});

// Update or add translation with versioning
app.put('/api/translation/:key', (req, res) => {
  const key = req.params.key;
  const { english, arabic, tags } = req.body;

  const newVersion = Math.floor(Date.now() / 1000); // Current epoch timestamp

  let translation = translations.data.find(item => item.key === key);

  if (translation) {
    translation.english = english;
    translation.arabic = arabic || '';
    translation.tags = tags || [];
    translation.version = newVersion;
  } else {
    translations.data.push({ key, english, arabic: arabic || '', tags: tags || [], version: newVersion });
  }

  saveTranslations(); // Save updated translations

  res.json({
    success: true,
    message: "Translation updated successfully",
    version: newVersion
  });
});

// Get all translations with version greater than a specified version and optional tag filter
app.get('/api/translations-since/:version', (req, res) => {
  const version = parseInt(req.params.version, 10);
  const tag = req.query.tag; // Get the tag from query parameters

  let updatedTranslations = translations.data.filter(item => item.version > version);

  if (tag) {
    // Filter by tag if the tag parameter is provided
    updatedTranslations = updatedTranslations.filter(item => item.tags.includes(tag));
  }

  res.json(updatedTranslations);
});

// Delete translation
app.delete('/api/translation/:key', (req, res) => {
  const key = req.params.key;
  translations.data = translations.data.filter(item => item.key !== key);

  saveTranslations(); // Save updated translations

  res.json({
    success: true,
    message: "Translation deleted successfully"
  });
});

// Search for an English translation
app.get('/api/search-english/:english', (req, res) => {
  const english = req.params.english.toLowerCase();
  const translation = translations.data.find(item => item.english.toLowerCase() === english);

  if (translation) {
    res.json({
      key: translation.key,
      english: translation.english,
      arabic: translation.arabic,
      tags: translation.tags,
      version: translation.version,
    });
  } else {
    res.status(404).json({ error: "Translation not found" });
  }
});

// POST route for bulk upload with JSON files
app.post('/api/upload-json', upload.fields([{ name: 'englishJson' }, { name: 'arabicJson' }]), (req, res) => {
  const englishJsonPath = req.files['englishJson'][0].path;
  const arabicJsonPath = req.files['arabicJson'][0].path;
  const tags = req.query.tags ? req.query.tags.split(',') : [];

  try {
    const englishData = JSON.parse(fs.readFileSync(englishJsonPath, 'utf8'));
    const arabicData = JSON.parse(fs.readFileSync(arabicJsonPath, 'utf8'));

    const mergedData = mergeTranslations(englishData, arabicData, tags);

    if (!mergedData.valid) {
      return res.status(400).json({ error: `Both English and Arabic translations must be present for the key: ${mergedData.missingKey}` });
    }

    saveTranslations(); // Save updated translations

    if (mergedData.duplicates.length > 0) {
      res.json({ success: true, message: 'Translations updated with duplicates found.', duplicates: mergedData.duplicates });
    } else {
      res.json({ success: true, message: 'Translations updated successfully.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to process the files.' });
  } finally {
    // Clean up uploaded files
    fs.unlinkSync(englishJsonPath);
    fs.unlinkSync(arabicJsonPath);
  }
});

// POST route for bulk upload with Excel file
app.post('/api/upload-excel', upload.single('excelFile'), (req, res) => {
  const excelFilePath = req.file.path;
  const tags = req.query.tags ? req.query.tags.split(',') : [];

  try {
    const workbook = xlsx.readFile(excelFilePath);
    const sheetName = workbook.SheetNames[0];
    const sheetData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const mergedData = processExcelData(sheetData, tags);

    if (!mergedData.valid) {
      return res.status(400).json({ error: `Both English and Arabic translations must be present for the key: ${mergedData.missingKey}` });
    }

    saveTranslations(); // Save updated translations

    if (mergedData.duplicates.length > 0) {
      res.json({ success: true, message: 'Translations updated with duplicates found.', duplicates: mergedData.duplicates });
    } else {
      res.json({ success: true, message: 'Translations updated successfully.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to process the Excel file.' });
  } finally {
    fs.unlinkSync(excelFilePath);
  }
});

// POST route for bulk update with JSON data
app.post('/api/bulk-update', (req, res) => {
  const { englishJson, arabicJson, tags } = req.body;

  try {
    const mergedData = mergeTranslations(englishJson, arabicJson, tags);

    if (!mergedData.valid) {
      return res.status(400).json({ error: `Both English and Arabic translations must be present for the key: ${mergedData.missingKey}` });
    }

    saveTranslations(); // Save updated translations

    if (mergedData.duplicates.length > 0) {
      res.json({ success: true, message: 'Translations updated with duplicates found.', duplicates: mergedData.duplicates });
    } else {
      res.json({ success: true, message: 'Translations updated successfully.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to process the JSON data.' });
  }
});

// Update the mergeTranslations and processExcelData functions to include tags
function mergeTranslations(englishData, arabicData, tags) {
  const data = [];
  const duplicates = [];

  for (const key in englishData) {
    if (englishData.hasOwnProperty(key)) {
      if (arabicData.hasOwnProperty(key)) {
        const existingTranslation = translations.data.find(item => item.english.toLowerCase() === englishData[key].toLowerCase());
        if (existingTranslation) {
          // Update existing translation with new data instead of overriding
          existingTranslation.arabic = arabicData[key];
          existingTranslation.tags = [...new Set([...(existingTranslation.tags || []), ...tags])];
          duplicates.push({
            key: existingTranslation.key,
            english: existingTranslation.english,
            arabic: existingTranslation.arabic,
            tags: existingTranslation.tags,
          });
        } else {
          data.push({
            key,
            english: englishData[key],
            arabic: arabicData[key],
            tags: tags,
          });
        }
      } else {
        return { valid: false, missingKey: key, duplicates };
      }
    }
  }

  for (const key in arabicData) {
    if (arabicData.hasOwnProperty(key) && !englishData.hasOwnProperty(key)) {
      return { valid: false, missingKey: key, duplicates };
    }
  }

  // Merge new data with existing translations
  translations.data = translations.data.concat(data);

  return { valid: true, data, duplicates };
}

function processExcelData(sheetData, tags) {
  const data = [];
  const duplicates = [];

  for (const row of sheetData) {
    if (row.key && row.english && row.arabic) {
      const existingTranslation = translations.data.find(item => item.english.toLowerCase() === row.english.toLowerCase());
      if (existingTranslation) {
        // Update existing translation with new data instead of overriding
        existingTranslation.arabic = row.arabic;
        existingTranslation.tags = [...new Set([...(existingTranslation.tags || []), ...tags])];
        duplicates.push({
          key: existingTranslation.key,
          english: existingTranslation.english,
          arabic: existingTranslation.arabic,
          tags: existingTranslation.tags,
        });
      } else {
        data.push({
          key: row.key,
          english: row.english,
          arabic: row.arabic,
          tags: tags,
        });
      }
    } else {
      return { valid: false, missingKey: row.key, duplicates };
    }
  }

  // Merge new data with existing translations
  translations.data = translations.data.concat(data);

  return { valid: true, data, duplicates };
}


// Start the server
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
