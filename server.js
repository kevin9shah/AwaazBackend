const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();

// CORS Configuration
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:3001', 
    'http://localhost:5173',  // Vite dev server
    'http://localhost:5174',  // Alternative Vite port
    'http://localhost:5175',  // Alternative Vite port
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'https://awaaz-vr.vercel.app'
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

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Generate questions using OpenAI
async function generateQuestionsWithOpenAI(slideText, slideNumber) {
  try {
    const prompt = `Based on this slide content from slide ${slideNumber}:
    "${slideText}"
    
    Generate exactly 1 relevant audience question that someone might ask during a presentation about this content. 
    The question should be specific, thoughtful, and relevant to the slide content.
    Return only the question text, nothing else.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI API Error:', error);
    return null;
  }
}

// Generate speech content using OpenAI
async function generateSpeechContentWithOpenAI(slideText, slideNumber) {
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

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI API Error:', error);
    return null;
  }
}

// Process PDF text and generate content with rate limiting
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
      
      // Generate questions with OpenAI
      console.log(`Generating questions for slide ${slideNumber}...`);
      try {
        // Add delay between API calls to respect rate limits
        if (i > 0) {
          console.log('Waiting 25 seconds to avoid rate limits...');
          await new Promise(resolve => setTimeout(resolve, 25000));
        }
        
        const question = await generateQuestionsWithOpenAI(extractedText, slideNumber);
        if (question) {
          questionsData[slideNumber] = [question];
          console.log(`✓ Question generated for slide ${slideNumber}: "${question.substring(0, 100)}..."`);
        } else {
          console.log(`✗ No question generated for slide ${slideNumber}`);
        }
      } catch (error) {
        console.error(`Error generating question for slide ${slideNumber}:`, error);
      }
      
      // Generate speech content with OpenAI
      console.log(`Generating speech content for slide ${slideNumber}...`);
      try {
        // Additional delay for speech generation
        console.log('Waiting 25 seconds to avoid rate limits...');
        await new Promise(resolve => setTimeout(resolve, 25000));
        
        const speech = await generateSpeechContentWithOpenAI(extractedText, slideNumber);
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

// Generate report using AI analysis with batch processing
async function generateReport(qaPairs) {
  console.log(`Starting batch evaluation for ${qaPairs.length} QA pairs...`);
  
  try {
    // Use the new batch evaluation function
    const evaluations = await evaluateAllAnswersWithOpenAI(qaPairs);
    
    const results = [];
    for (let i = 0; i < qaPairs.length; i++) {
      const { question, userAnswer } = qaPairs[i];
      const evaluation = evaluations[i];
      
      results.push({
        "Question": question,
        "User Answer": userAnswer,
        "Reference Answer": evaluation.referenceAnswer,
        "Similarity Score": evaluation.similarity,
        "Missing Points": evaluation.missingPoints
      });
    }
    
    console.log(`✓ Successfully evaluated all ${qaPairs.length} questions in single API call`);
    return results;
    
  } catch (error) {
    console.error('Batch evaluation failed, falling back to individual evaluations:', error);
    
    // Fallback to individual evaluations if batch fails
    const results = [];
    
    for (let i = 0; i < qaPairs.length; i++) {
      const { question, userAnswer } = qaPairs[i];
      
      try {
        console.log(`Evaluating question ${i + 1}/${qaPairs.length}: "${question.substring(0, 50)}..."`);
        
        // Add delay between requests to avoid rate limiting (20 seconds for free tier)
        if (i > 0) {
          console.log('Waiting 25 seconds to avoid rate limits...');
          await new Promise(resolve => setTimeout(resolve, 25000));
        }
        
        const evaluation = await evaluateAnswerWithOpenAI(question, userAnswer);
        
        results.push({
          "Question": question,
          "User Answer": userAnswer,
          "Reference Answer": evaluation.referenceAnswer,
          "Similarity Score": evaluation.similarity,
          "Missing Points": evaluation.missingPoints
        });
        
        console.log(`✓ Question ${i + 1} evaluated successfully`);
        
      } catch (error) {
        console.error(`Error evaluating question: ${question}`, error);
        // Add a fallback result for failed evaluations
        results.push({
          "Question": question,
          "User Answer": userAnswer,
          "Reference Answer": "Unable to generate reference answer due to rate limits",
          "Similarity Score": 0,
          "Missing Points": "Evaluation failed - API rate limit exceeded"
        });
      }
    }
    
    return results;
  }
}

// Evaluate all answers using OpenAI in a single call
async function evaluateAllAnswersWithOpenAI(qaPairs, retryCount = 0) {
  try {
    // Build the prompt for all questions at once
    let prompt = `Evaluate the following question and answer pairs. For each pair, provide a comprehensive reference answer, similarity score (0-100), and missing key points.

Respond with a JSON array where each object follows this exact format:
{
  "questionIndex": 1,
  "referenceAnswer": "Your ideal answer here",
  "similarity": 85,
  "missingPoints": "Key points the user missed"
}

Question and Answer Pairs:
`;

    // Add each Q&A pair to the prompt
    qaPairs.forEach((pair, index) => {
      prompt += `
${index + 1}. Question: "${pair.question}"
   User Answer: "${pair.userAnswer}"
`;
    });

    prompt += `
Please evaluate all ${qaPairs.length} question-answer pairs and return a JSON array with ${qaPairs.length} evaluation objects.`;

    console.log(`Sending ${qaPairs.length} questions to OpenAI for evaluation...`);

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 800 * qaPairs.length, // Adjust tokens based on number of questions
      temperature: 0.5,
    });

    const responseText = completion.choices[0].message.content.trim();
    console.log('OpenAI Response received:', responseText.substring(0, 200) + '...');
    
    // Try to parse the JSON response
    try {
      // Clean the response text (remove potential markdown formatting)
      let cleanedResponse = responseText;
      if (cleanedResponse.includes('```json')) {
        cleanedResponse = cleanedResponse.replace(/```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleanedResponse.includes('```')) {
        cleanedResponse = cleanedResponse.replace(/```\s*/, '').replace(/```\s*$/, '');
      }
      
      const parsed = JSON.parse(cleanedResponse);
      
      // Ensure we have an array
      const evaluations = Array.isArray(parsed) ? parsed : [parsed];
      
      // Map the results back to the expected format
      const results = [];
      for (let i = 0; i < qaPairs.length; i++) {
        const evaluation = evaluations.find(e => e.questionIndex === i + 1) || evaluations[i] || {};
        
        results.push({
          referenceAnswer: evaluation.referenceAnswer || "No reference answer generated",
          similarity: evaluation.similarity || 0,
          missingPoints: evaluation.missingPoints || "No missing points identified"
        });
      }
      
      return results;
      
    } catch (parseError) {
      console.error('JSON parsing failed:', parseError);
      console.log('Raw response:', responseText);
      
      // Fallback: create default responses for all questions
      return qaPairs.map((_, index) => ({
        referenceAnswer: "Unable to parse AI response for this question",
        similarity: 0,
        missingPoints: "Response parsing failed"
      }));
    }
    
  } catch (error) {
    console.error('OpenAI API Error in batch evaluation:', error);
    
    // Handle rate limiting with retry
    if (error.status === 429 && retryCount < 2) {
      const waitTime = error.headers && error.headers['retry-after'] 
        ? parseInt(error.headers['retry-after']) * 1000 + 5000
        : 30000;
      
      console.log(`Rate limited. Retrying in ${waitTime/1000} seconds... (Attempt ${retryCount + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return evaluateAllAnswersWithOpenAI(qaPairs, retryCount + 1);
    }
    
    // Handle other errors - return fallback responses
    if (error.status === 429) {
      return qaPairs.map((_, index) => ({
        referenceAnswer: "Rate limit exceeded. Please upgrade your OpenAI plan or try again later.",
        similarity: 0,
        missingPoints: "Unable to evaluate due to API rate limits."
      }));
    }
    
    throw error;
  }
}

// Evaluate answer using OpenAI with retry logic (keeping for backwards compatibility)
async function evaluateAnswerWithOpenAI(question, userAnswer, retryCount = 0) {
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

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 300,
      temperature: 0.5,
    });

    const responseText = completion.choices[0].message.content.trim();
    
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
    console.error('OpenAI API Error in evaluation:', error);
    
    // Handle rate limiting with retry
    if (error.status === 429 && retryCount < 2) {
      const waitTime = error.headers && error.headers['retry-after'] 
        ? parseInt(error.headers['retry-after']) * 1000 + 5000  // Add 5 extra seconds
        : 30000; // Default 30 seconds
      
      console.log(`Rate limited. Retrying in ${waitTime/1000} seconds... (Attempt ${retryCount + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return evaluateAnswerWithOpenAI(question, userAnswer, retryCount + 1);
    }
    
    // Handle other rate limit cases
    if (error.status === 429) {
      return {
        referenceAnswer: "Rate limit exceeded. Please upgrade your OpenAI plan or try again later.",
        similarity: 0,
        missingPoints: "Unable to evaluate due to API rate limits. Consider upgrading to a paid plan."
      };
    }
    
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

    res.status(200).json({
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

// Rate limit info endpoint
app.get('/api/rate-limit-info', async (req, res) => {
  res.json({
    success: true,
    info: {
      provider: "OpenAI",
      tier: "Free Tier",
      limits: {
        "requests_per_minute": 3,
        "tokens_per_minute": 40000
      },
      recommendations: [
        "Wait 25 seconds between requests to avoid rate limits",
        "For faster processing, upgrade to a paid OpenAI plan",
        "Free tier allows 3 requests per minute",
        "Paid tier allows 3500+ requests per minute"
      ],
      upgrade_info: "Visit https://platform.openai.com/account/billing to add payment method"
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;