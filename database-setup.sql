-- Create presentations table
CREATE TABLE presentations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    unique_code VARCHAR(5) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    slide_count INTEGER NOT NULL DEFAULT 0,
    slide_texts JSONB DEFAULT '{}'::jsonb,
    questions JSONB DEFAULT '{}'::jsonb,
    speech_content JSONB DEFAULT '{}'::jsonb,
    has_images BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- Add this to your database-setup.sql file

-- Create reports table
CREATE TABLE reports (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    unique_code VARCHAR(5) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    total_questions INTEGER NOT NULL DEFAULT 0,
    average_score DECIMAL(5,2) DEFAULT 0,
    pass_rate INTEGER DEFAULT 0,
    report_data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_reports_unique_code ON reports(unique_code);
CREATE INDEX idx_reports_created_at ON reports(created_at DESC);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_reports_updated_at BEFORE UPDATE ON reports
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- Create storage bucket for presentation slides
INSERT INTO storage.buckets (id, name, public) VALUES ('presentation-slides', 'presentation-slides', true);

-- Create storage policy to allow public read access
CREATE POLICY "Public read access for presentation slides" ON storage.objects
FOR SELECT USING (bucket_id = 'presentation-slides');

-- Create storage policy to allow authenticated upload
CREATE POLICY "Allow upload of presentation slides" ON storage.objects
FOR INSERT WITH CHECK (bucket_id = 'presentation-slides');

-- Create indexes for better performance
CREATE INDEX idx_presentations_unique_code ON presentations(unique_code);
CREATE INDEX idx_presentations_created_at ON presentations(created_at DESC);

-- Create function for updating timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$ language 'plpgsql';

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_presentations_updated_at BEFORE UPDATE ON presentations
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();