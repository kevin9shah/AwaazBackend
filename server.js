const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdf2pic = require('pdf2pic');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// File upload configuration
const upload = multer({
  dest: 'temp/',
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /\.(pdf)$/i;
    if (allowedTypes.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Generate 5-digit unique code
function generateUniqueCode() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// Convert PDF to images with better Windows compatibility
async function convertPdfToImages(pdfPath, outputDir) {
  try {
    const convert = pdf2pic.fromPath(pdfPath, {
      density: 150,           // Lower density for better performance
      saveFilename: "slide",
      savePath: outputDir,
      format: "png",
      width: 1024,           // Smaller size for better performance
      height: 768
    });

    // Try to convert all pages
    const results = await convert.bulk(-1);
    return results;
  } catch (error) {
    console.error('PDF2PIC Error:', error);
    
    // Fallback: try page by page
    try {
      console.log('Trying page-by-page conversion...');
      const convert = pdf2pic.fromPath(pdfPath, {
        density: 100,
        saveFilename: "slide",
        savePath: outputDir,
        format: "png",
        width: 800,
        height: 600
      });

      // Try converting first 10 pages individually
      const results = [];
      for (let i = 1; i <= 10; i++) {
        try {
          const result = await convert(i);
          results.push(result);
        } catch (pageError) {
          console.log(`Page ${i} conversion failed, stopping...`);
          break;
        }
      }
      return results;
    } catch (fallbackError) {
      console.error('Fallback conversion also failed:', fallbackError);
      throw new Error('PDF to image conversion failed. Please ensure the PDF is valid and not corrupted.');
    }
  }
}

// Extract text directly from PDF as backup
async function extractTextFromPdf(pdfPath) {
  try {
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    
    // Split text by pages (approximate)
    const text = data.text;
    const pages = text.split('\f'); // Form feed character often separates pages
    
    // If no form feed characters, try to split by common page breaks
    if (pages.length === 1) {
      const splitText = text.split(/\n\s*\n\s*\n/);
      return splitText.filter(page => page.trim().length > 0);
    }
    
    return pages.filter(page => page.trim().length > 0);
  } catch (error) {
    console.error('PDF text extraction error:', error);
    return [];
  }
}

// Extract text from image using OCR
async function extractTextFromImage(imagePath) {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, 'eng', {
      logger: m => console.log(m)
    });
    return text.trim();
  } catch (error) {
    console.error('OCR Error:', error);
    return '';
  }
}

// Generate questions using Gemini
async function generateQuestionsWithGemini(slideText, slideNumber) {
  try {
    const prompt = `Based on this slide content from slide ${slideNumber}:
    "${slideText}"
    
    Generate exactly 1 relevant audience question that someone might ask during a presentation about this content. 
    The question should be specific, thoughtful, and relevant to the slide content.
    Return only the question text, nothing else.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    console.error('Gemini API Error:', error);
    return null;
  }
}

// Generate speech content using Gemini
async function generateSpeechContentWithGemini(slideText, slideNumber) {
  try {
    const prompt = `Based on this slide content from slide ${slideNumber}:
    "${slideText}"
    
    Generate appropriate speaking content that a presenter could use to present this slide. 
    The content should be:
    - Clear and professional
    - 2-3 sentences long
    - Easy to speak and remember
    - Engaging for the audience
    
    Return only the speech content, nothing else.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    console.error('Gemini API Error:', error);
    return null;
  }
}

// Upload and process PDF
app.post('/api/upload-presentation', upload.single('pdf'), async (req, res) => {
  let tempDir = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Generate unique code
    const uniqueCode = generateUniqueCode();
    
    // Create temporary directory for processing
    tempDir = path.join(__dirname, 'temp', uniqueCode);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Try to convert PDF to images first
    let imageResults = [];
    let useTextFallback = false;
    
    try {
      console.log('Converting PDF to images...');
      imageResults = await convertPdfToImages(req.file.path, tempDir);
      console.log(`Successfully converted ${imageResults.length} pages to images`);
    } catch (conversionError) {
      console.log('Image conversion failed, using text extraction fallback...');
      useTextFallback = true;
    }

    const slideData = {};
    const questionsData = {};
    const speechContent = {};
    
    if (!useTextFallback && imageResults.length > 0) {
      // Process images and extract text using OCR
      for (let i = 0; i < imageResults.length; i++) {
        const slideNumber = i + 1;
        const imagePath = imageResults[i].path;
        
        console.log(`Processing slide ${slideNumber} with image...`);
        
        // Upload image to Supabase storage
        const imageBuffer = fs.readFileSync(imagePath);
        const fileName = `${uniqueCode}/slide_${slideNumber}.png`;
        
        const { error: uploadError } = await supabase.storage
          .from('presentation-slides')
          .upload(fileName, imageBuffer, {
            contentType: 'image/png',
            upsert: true
          });

        if (uploadError) {
          console.error('Upload error:', uploadError);
          continue;
        }

        // Extract text using OCR
        console.log(`Extracting text from slide ${slideNumber} image...`);
        const extractedText = await extractTextFromImage(imagePath);
        
        if (extractedText) {
          slideData[slideNumber] = extractedText;
          
          // Generate questions with Gemini
          console.log(`Generating questions for slide ${slideNumber}...`);
          const question = await generateQuestionsWithGemini(extractedText, slideNumber);
          if (question) {
            questionsData[slideNumber] = [question];
          }
          
          // Generate speech content with Gemini
          console.log(`Generating speech content for slide ${slideNumber}...`);
          const speech = await generateSpeechContentWithGemini(extractedText, slideNumber);
          if (speech) {
            speechContent[slideNumber] = speech;
          }
        }
      }
    } else {
      // Fallback: Extract text directly from PDF
      console.log('Using text extraction fallback...');
      const pdfPages = await extractTextFromPdf(req.file.path);
      
      for (let i = 0; i < pdfPages.length; i++) {
        const slideNumber = i + 1;
        const extractedText = pdfPages[i].trim();
        
        console.log(`Processing slide ${slideNumber} with text...`);
        
        if (extractedText) {
          slideData[slideNumber] = extractedText;
          
          // Generate questions with Gemini
          console.log(`Generating questions for slide ${slideNumber}...`);
          const question = await generateQuestionsWithGemini(extractedText, slideNumber);
          if (question) {
            questionsData[slideNumber] = [question];
          }
          
          // Generate speech content with Gemini
          console.log(`Generating speech content for slide ${slideNumber}...`);
          const speech = await generateSpeechContentWithGemini(extractedText, slideNumber);
          if (speech) {
            speechContent[slideNumber] = speech;
          }
        }
      }
      imageResults = pdfPages; // Set length for response
    }

    const slideCount = useTextFallback ? Object.keys(slideData).length : imageResults.length;

    // Store in database
    const { error: dbError } = await supabase
      .from('presentations')
      .insert({
        unique_code: uniqueCode,
        title: req.body.title || path.parse(req.file.originalname).name,
        filename: req.file.originalname,
        slide_count: slideCount,
        slide_texts: slideData,
        questions: questionsData,
        speech_content: speechContent,
        has_images: !useTextFallback,
        created_at: new Date().toISOString()
      });

    if (dbError) {
      throw new Error(`Database error: ${dbError.message}`);
    }

    // Clean up temporary files
    fs.rmSync(req.file.path);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    res.json({
      success: true,
      code: uniqueCode,
      slideCount: slideCount,
      hasImages: !useTextFallback,
      message: useTextFallback ? 'PDF processed with text extraction (images failed)' : 'PDF processed with images'
    });

  } catch (error) {
    console.error('Processing error:', error);
    
    // Clean up on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.rmSync(req.file.path);
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    
    res.status(500).json({ 
      error: 'Failed to process presentation',
      details: error.message 
    });
  }
});

// Get presentation data by code
app.get('/api/presentation/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    // Fetch presentation from database
    const { data: presentation, error } = await supabase
      .from('presentations')
      .select('*')
      .eq('unique_code', code)
      .single();

    if (error || !presentation) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    // Get signed URLs for slides if images exist
    const slideUrls = {};
    if (presentation.has_images) {
      for (let i = 1; i <= presentation.slide_count; i++) {
        const fileName = `${code}/slide_${i}.png`;
        
        const { data: signedUrl } = await supabase.storage
          .from('presentation-slides')
          .createSignedUrl(fileName, 3600); // 1 hour expiry
        
        if (signedUrl) {
          slideUrls[i] = signedUrl.signedUrl;
        }
      }
    }

    res.json({
      success: true,
      presentation: {
        code: presentation.unique_code,
        title: presentation.title,
        slideCount: presentation.slide_count,
        hasImages: presentation.has_images || false,
        slideUrls: slideUrls,
        slideTexts: presentation.slide_texts,
        questions: presentation.questions,
        speechContent: presentation.speech_content,
        createdAt: presentation.created_at
      }
    });

  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch presentation',
      details: error.message 
    });
  }
});

// Initialize database tables
app.post('/api/setup-database', async (req, res) => {
  try {
    // Create storage bucket first
    const { error: bucketError } = await supabase.storage.createBucket('presentation-slides', {
      public: true
    });

    // Bucket might already exist, that's okay
    if (bucketError && !bucketError.message.includes('already exists')) {
      console.warn('Bucket creation warning:', bucketError.message);
    }

    res.json({
      success: true,
      message: 'Database setup completed successfully',
      note: 'Please create the presentations table manually in Supabase SQL editor'
    });

  } catch (error) {
    console.error('Database setup error:', error);
    res.status(500).json({
      error: 'Failed to setup database',
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;