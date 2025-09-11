const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

// CORS Configuration
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:3001', 
    'http://localhost:5173',  // Vite dev server
    'http://localhost:5174',  // Alternative Vite port
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Middleware
app.use(cors(corsOptions));
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

// Convert PDF to images using Python script
async function convertPdfToImages(pdfPath, outputDir) {
  return new Promise((resolve, reject) => {
    const command = `python test.py "${pdfPath}" "${outputDir}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing python script: ${error}`);
        return reject(new Error('PDF to image conversion failed.'));
      }
      if (stderr) {
        console.error(`Python script stderr: ${stderr}`);
      }
      console.log(`Python script stdout: ${stdout}`);
      
      // Read the output directory to get the list of images
      fs.readdir(outputDir, (err, files) => {
        if (err) {
          console.error(`Error reading output directory: ${err}`);
          return reject(new Error('Failed to read output directory.'));
        }
        const images = files.map(file => ({ path: path.join(outputDir, file) }));
        resolve(images);
      });
    });
  });
}

// Extract text directly from PDF
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

// Upload images to Supabase storage
async function uploadImagesToSupabase(imageResults, uniqueCode) {
  const uploadedSlides = {};
  
  for (let i = 0; i < imageResults.length; i++) {
    const slideNumber = i + 1;
    const imagePath = imageResults[i].path;
    
    try {
      console.log(`Uploading slide ${slideNumber} image to Supabase...`);
      
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
        console.error(`Upload error for slide ${slideNumber}:`, uploadError);
        continue;
      }
      
      uploadedSlides[slideNumber] = true;
      console.log(`Successfully uploaded slide ${slideNumber}`);
      
    } catch (error) {
      console.error(`Error uploading slide ${slideNumber}:`, error);
    }
  }
  
  return uploadedSlides;
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

// Process PDF text and generate content
async function processTextContent(pdfPages, uniqueCode) {
  const slideData = {};
  const questionsData = {};
  const speechContent = {};
  
  console.log(`Starting to process ${pdfPages.length} pages of text content...`);
  
  for (let i = 0; i < pdfPages.length; i++) {
    const slideNumber = i + 1;
    const extractedText = pdfPages[i].trim();
    
    console.log(`\n--- Processing slide ${slideNumber} ---`);
    console.log(`Text length: ${extractedText.length} characters`);
    console.log(`Text preview: "${extractedText.substring(0, 150)}..."`);
    
    if (extractedText && extractedText.length > 10) { // Minimum text length check
      slideData[slideNumber] = extractedText;
      
      // Generate questions with Gemini
      console.log(`Generating questions for slide ${slideNumber}...`);
      try {
        const question = await generateQuestionsWithGemini(extractedText, slideNumber);
        if (question) {
          questionsData[slideNumber] = [question];
          console.log(`✓ Question generated for slide ${slideNumber}: "${question.substring(0, 100)}..."`);
        } else {
          console.log(`✗ No question generated for slide ${slideNumber}`);
        }
      } catch (error) {
        console.error(`Error generating question for slide ${slideNumber}:`, error);
      }
      
      // Generate speech content with Gemini
      console.log(`Generating speech content for slide ${slideNumber}...`);
      try {
        const speech = await generateSpeechContentWithGemini(extractedText, slideNumber);
        if (speech) {
          speechContent[slideNumber] = speech;
          console.log(`✓ Speech generated for slide ${slideNumber}: "${speech.substring(0, 100)}..."`);
        } else {
          console.log(`✗ No speech generated for slide ${slideNumber}`);
        }
      } catch (error) {
        console.error(`Error generating speech for slide ${slideNumber}:`, error);
      }
    } else {
      console.log(`⚠ Skipping slide ${slideNumber} - insufficient text content`);
    }
  }
  
  console.log(`\n--- Processing Summary ---`);
  console.log(`Slides with text: ${Object.keys(slideData).length}`);
  console.log(`Slides with questions: ${Object.keys(questionsData).length}`);
  console.log(`Slides with speech: ${Object.keys(speechContent).length}`);
  
  return { slideData, questionsData, speechContent };
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

    // STEP 1: Extract text directly from PDF (always do this)
    console.log('Extracting text from PDF...');
    const pdfPages = await extractTextFromPdf(req.file.path);
    console.log(`Extracted text from ${pdfPages.length} pages`);

    // STEP 2: Process text content (generate questions and speech)
    console.log('Processing text content and generating AI content...');
    const { slideData, questionsData, speechContent } = await processTextContent(pdfPages, uniqueCode);

    // STEP 3: Try to convert PDF to images and upload them
    let hasImages = false;
    let imageUploadResults = {};
    
    try {
      console.log('Converting PDF to images...');
      const imageResults = await convertPdfToImages(req.file.path, tempDir);
      console.log(`Successfully converted ${imageResults.length} pages to images`);
      
      // Upload images to Supabase
      console.log('Uploading images to Supabase...');
      imageUploadResults = await uploadImagesToSupabase(imageResults, uniqueCode);
      hasImages = Object.keys(imageUploadResults).length > 0;
      
      console.log(`Successfully uploaded ${Object.keys(imageUploadResults).length} images`);
      
    } catch (conversionError) {
      console.log('Image conversion failed, continuing without images...');
      console.error(conversionError.message);
      hasImages = false;
    }

    const slideCount = pdfPages.length;

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
        has_images: hasImages,
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
      hasImages: hasImages,
      uploadedImages: Object.keys(imageUploadResults).length,
      message: hasImages 
        ? `PDF processed successfully with ${Object.keys(imageUploadResults).length} images uploaded`
        : 'PDF processed successfully (text only, image conversion failed)'
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

// Add this to your server.js file

// Generate report using AI analysis
async function generateReport(qaPairs) {
  const results = [];
  
  for (const { question, userAnswer } of qaPairs) {
    try {
      const evaluation = await evaluateAnswerWithGemini(question, userAnswer);
      
      results.push({
        "Question": question,
        "User Answer": userAnswer,
        "Reference Answer": evaluation.referenceAnswer,
        "Similarity Score": evaluation.similarity,
        "Missing Points": evaluation.missingPoints
      });
    } catch (error) {
      console.error(`Error evaluating question: ${question}`, error);
      // Add a fallback result for failed evaluations
      results.push({
        "Question": question,
        "User Answer": userAnswer,
        "Reference Answer": "Unable to generate reference answer",
        "Similarity Score": 0,
        "Missing Points": "Evaluation failed"
      });
    }
  }
  
  return results;
}

// Evaluate answer using Gemini AI
async function evaluateAnswerWithGemini(question, userAnswer) {
  try {
    const prompt = `
    Evaluate the following question and answer pair:
    
    Question: "${question}"
    User Answer: "${userAnswer}"
    
    Please provide:
    1. A comprehensive reference answer (2-3 sentences)
    2. A similarity score between 0-100 (how well the user answer matches the ideal answer)
    3. Missing key points from the user's answer
    
    Respond in this exact JSON format:
    {
      "referenceAnswer": "Your ideal answer here",
      "similarity": 85,
      "missingPoints": "Key points the user missed"
    }`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text().trim();
    
    // Try to parse the JSON response
    try {
      const parsed = JSON.parse(responseText);
      return {
        referenceAnswer: parsed.referenceAnswer || "No reference answer generated",
        similarity: parsed.similarity || 0,
        missingPoints: parsed.missingPoints || "No missing points identified"
      };
    } catch (parseError) {
      // Fallback if JSON parsing fails
      return {
        referenceAnswer: "Unable to parse AI response",
        similarity: 0,
        missingPoints: "Response parsing failed"
      };
    }
    
  } catch (error) {
    console.error('Gemini API Error in evaluation:', error);
    throw error;
  }
}

// Generate report and save to database
app.post('/api/generate-report', async (req, res) => {
  try {
    // Validate request body
    const { qaPairs, title } = req.body;
    
    if (!qaPairs || !Array.isArray(qaPairs)) {
      return res.status(400).json({ 
        error: 'qaPairs must be an array',
        example: {
          qaPairs: [
            {
              question: "What is cloud computing?",
              userAnswer: "Cloud computing is delivery of computing services over the internet"
            }
          ],
          title: "Interview Report" // optional
        }
      });
    }

    // Validate each QA pair
    for (let i = 0; i < qaPairs.length; i++) {
      const pair = qaPairs[i];
      if (!pair.question || !pair.userAnswer) {
        return res.status(400).json({ 
          error: `QA pair at index ${i} must have both 'question' and 'userAnswer' fields` 
        });
      }
    }

    console.log(`Starting report generation for ${qaPairs.length} QA pairs...`);

    // Generate unique 5-digit code for the report
    const uniqueCode = generateUniqueCode();
    
    // Generate the report using AI
    const reportData = await generateReport(qaPairs);
    
    // Calculate overall statistics
    const totalQuestions = reportData.length;
    const averageScore = reportData.reduce((sum, item) => sum + item["Similarity Score"], 0) / totalQuestions;
    const passedQuestions = reportData.filter(item => item["Similarity Score"] >= 70).length;
    
    // Create the final report object
    const finalReport = {
      code: uniqueCode,
      title: title || `Interview Report - ${new Date().toLocaleDateString()}`,
      generatedAt: new Date().toISOString(),
      summary: {
        totalQuestions: totalQuestions,
        averageScore: Math.round(averageScore * 100) / 100,
        passedQuestions: passedQuestions,
        passRate: Math.round((passedQuestions / totalQuestions) * 100)
      },
      evaluations: reportData
    };

    // Store in database (you'll need to create a 'reports' table)
    const { error: dbError } = await supabase
      .from('reports')
      .insert({
        unique_code: uniqueCode,
        title: finalReport.title,
        total_questions: totalQuestions,
        average_score: averageScore,
        pass_rate: Math.round((passedQuestions / totalQuestions) * 100),
        report_data: finalReport,
        created_at: new Date().toISOString()
      });

    if (dbError) {
      throw new Error(`Database error: ${dbError.message}`);
    }

    console.log(`Report generated successfully with code: ${uniqueCode}`);

    // Return the response
    res.json({
      success: true,
      code: uniqueCode,
      message: 'Report generated successfully',
      summary: finalReport.summary,
      report: finalReport
    });

  } catch (error) {
    console.error('Report generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate report',
      details: error.message
    });
  }
});

// Get report by code
app.get('/api/report/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    // Fetch report from database
    const { data: report, error } = await supabase
      .from('reports')
      .select('*')
      .eq('unique_code', code)
      .single();

    if (error || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json({
      success: true,
      report: report.report_data
    });

  } catch (error) {
    console.error('Fetch report error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch report',
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;