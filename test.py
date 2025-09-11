"""
PDF Page to Image Converter using PyMuPDF (fitz)
Converts each page of a PDF file into a separate image file.
"""

import os
import sys

def check_dependencies():
    """Check if required dependencies are installed."""
    try:
        import fitz
        
        # Check if this is the correct PyMuPDF fitz module
        if not hasattr(fitz, 'open'):
            print("Error: Wrong 'fitz' module detected!")
            print("You might have the wrong 'fitz' package installed.")
            print("Please uninstall it and install PyMuPDF:")
            print("  pip uninstall fitz")
            print("  pip install PyMuPDF")
            sys.exit(1)
            
        try:
            # Try different ways to get version info
            if hasattr(fitz, 'version'):
                if isinstance(fitz.version, tuple):
                    print(f"PyMuPDF version: {fitz.version[0]}")
                else:
                    print(f"PyMuPDF version: {fitz.version}")
            elif hasattr(fitz, '__version__'):
                print(f"PyMuPDF version: {fitz.__version__}")
            else:
                print("PyMuPDF is installed (version info not available)")
        except:
            print("PyMuPDF is installed")
        return fitz
    except ImportError as e:
        print("Error: PyMuPDF is not installed.")
        print("Please install it using:")
        print("  pip install PyMuPDF")
        sys.exit(1)

def pdf_pages_to_images(pdf_path, output_folder, image_format="png", dpi=300):
    """
    Convert each page of a PDF file into a separate image file.
    
    Args:
        pdf_path (str): Path to the input PDF file
        output_folder (str): Directory to save page images
        image_format (str): Output image format ('png', 'jpg', 'jpeg')
        dpi (int): Resolution for the output images
    
    Returns:
        int: Number of pages converted
    """
    
    # Import fitz after checking dependencies
    fitz = check_dependencies()
    
    try:
        # Check if PDF file exists
        if not os.path.exists(pdf_path):
            print(f"Error: PDF file '{pdf_path}' not found.")
            return 0
        
        # Open the PDF
        print(f"Opening PDF: {pdf_path}")
        pdf_document = fitz.open(pdf_path)
        
        # Check if PDF opened successfully
        if pdf_document.is_closed:
            print("Error: Failed to open PDF file.")
            return 0
        
        # Create output folder if it doesn't exist
        os.makedirs(output_folder, exist_ok=True)
        print(f"Output folder: {output_folder}")
        
        # Get total number of pages
        total_pages = len(pdf_document)
        print(f"Total pages in PDF: {total_pages}")
        print(f"Output format: {image_format.upper()}")
        print(f"Resolution: {dpi} DPI")
        print("-" * 50)
        
        # Convert each page to image
        converted_pages = 0
        
        for page_num in range(total_pages):
            try:
                print(f"Converting page {page_num + 1}/{total_pages}...")
                
                # Get the page
                page = pdf_document[page_num]
                
                # Create transformation matrix for the desired DPI
                # 72 DPI is the default, so we scale by dpi/72
                zoom = dpi / 72.0
                matrix = fitz.Matrix(zoom, zoom)
                
                # Render page to image
                pix = page.get_pixmap(matrix=matrix)
                
                # Generate filename
                page_filename = f"page_{page_num+1:03d}.{image_format.lower()}"
                image_path = os.path.join(output_folder, page_filename)
                
                # Save the image
                if image_format.lower() in ['jpg', 'jpeg']:
                    pix.save(image_path, output="jpeg")
                else:
                    pix.save(image_path)
                
                converted_pages += 1
                print(f"  Saved: {page_filename}")
                
                # Clean up
                pix = None
                
            except Exception as e:
                print(f"  Error converting page {page_num + 1}: {e}")
                continue
        
        # Close PDF
        pdf_document.close()
        
        print("-" * 50)
        print(f"Conversion completed!")
        print(f"Pages converted: {converted_pages}/{total_pages}")
        return converted_pages
        
    except Exception as e:
        print(f"Error: {e}")
        return 0

def main():
    """Main function with command line interface."""
    
    # Default values
    pdf_file = "doc.pdf"
    output_dir = "pdf_pages"
    image_format = "png"  # Can be 'png', 'jpg', or 'jpeg'
    dpi = 300  # Resolution
    
    # Check command line arguments
    if len(sys.argv) >= 2:
        pdf_file = sys.argv[1]
    if len(sys.argv) >= 3:
        output_dir = sys.argv[2]
    if len(sys.argv) >= 4:
        image_format = sys.argv[3]
    if len(sys.argv) >= 5:
        try:
            dpi = int(sys.argv[4])
        except ValueError:
            print("Warning: Invalid DPI value, using default 300 DPI")
            dpi = 300
    
    print("PDF Pages to Images Converter")
    print("=" * 50)
    
    # Validate image format
    if image_format.lower() not in ['png', 'jpg', 'jpeg']:
        print("Warning: Invalid image format, using PNG")
        image_format = 'png'
    
    # Convert pages to images
    converted_count = pdf_pages_to_images(pdf_file, output_dir, image_format, dpi)
    
    if converted_count > 0:
        print(f"Successfully converted {converted_count} pages to '{output_dir}'")
        print(f"Images saved as {image_format.upper()} files with {dpi} DPI resolution")
    else:
        print("\n✗ No pages were converted or an error occurred.")

if __name__ == "__main__":
    main()