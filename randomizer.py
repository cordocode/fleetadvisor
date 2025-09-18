#!/usr/bin/env python3
"""
Script to move, rename, and modify ONLY metadata of .tif files 
Does NOT touch image data - only metadata to avoid Lightroom duplicates
"""

import os
import shutil
import random
import string
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

def generate_random_name():
    """Generate a unique random filename"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    random_chars = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"img_{timestamp}_{random_chars}.tif"

def modify_metadata_with_exiftool(file_path):
    """
    Use exiftool to modify metadata without touching image data
    This makes Lightroom see it as a different file
    """
    try:
        # Generate unique metadata values
        random_date = datetime.now() - timedelta(seconds=random.randint(0, 31536000))
        date_str = random_date.strftime("%Y:%m:%d %H:%M:%S")
        unique_id = f"ID_{random.randint(100000000, 999999999)}"
        software = f"Batch_Process_{random.randint(1000, 9999)}"
        
        # Build exiftool command to modify multiple metadata fields
        cmd = [
            'exiftool',
            '-overwrite_original',  # Don't create backup
            f'-DateTimeOriginal={date_str}',
            f'-CreateDate={date_str}',
            f'-ModifyDate={date_str}', 
            f'-Software={software}',
            f'-ImageUniqueID={unique_id}',
            f'-ImageDescription=Processed_{datetime.now().timestamp()}',
            f'-UserComment=Batch_{random.randint(1000, 9999)}',
            str(file_path)
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0
        
    except Exception as e:
        print(f"Error modifying metadata: {e}")
        return False

def main():
    # Check if exiftool is installed
    try:
        subprocess.run(['exiftool', '-ver'], capture_output=True, check=True)
    except:
        print("ERROR: exiftool is not installed!")
        print("Install it with: brew install exiftool")
        return
    
    # Directories
    SOURCE_DIR = "/Users/cordo/Downloads/shuffle"
    DEST_DIR = "/Users/cordo/Downloads/shuffled"
    
    source_path = Path(SOURCE_DIR)
    dest_path = Path(DEST_DIR)
    
    # Check source exists
    if not source_path.exists():
        print(f"Error: Source directory '{SOURCE_DIR}' does not exist!")
        return
    
    # Create destination if needed
    dest_path.mkdir(parents=True, exist_ok=True)
    
    # Get ALL .tif files
    tif_files = list(source_path.glob("*.tif")) + list(source_path.glob("*.TIF"))
    
    if not tif_files:
        print("No .tif files found.")
        return
    
    print(f"Found {len(tif_files)} .tif files")
    print("Processing files with metadata modifications only...")
    print("Image data will NOT be touched\n")
    
    moved_count = 0
    used_names = set()
    
    for file_path in tif_files:
        # Generate unique name
        while True:
            new_name = generate_random_name()
            if new_name not in used_names:
                used_names.add(new_name)
                break
        
        dest_file_path = dest_path / new_name
        
        try:
            # First copy the file
            shutil.copy2(str(file_path), str(dest_file_path))
            
            # Then modify its metadata
            if modify_metadata_with_exiftool(dest_file_path):
                print(f"Processed: {file_path.name} -> {new_name} (metadata modified)")
            else:
                print(f"Moved: {file_path.name} -> {new_name} (metadata unchanged)")
            
            moved_count += 1
            
        except Exception as e:
            print(f"Error processing {file_path.name}: {e}")
    
    print(f"\nDONE! Processed {moved_count} files")
    print("Files have unique metadata and should import as separate images in Lightroom")
    print("Original image data untouched - only metadata was modified")

if __name__ == "__main__":
    main()