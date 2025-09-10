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