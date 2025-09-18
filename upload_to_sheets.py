#!/usr/bin/env python3

import pandas as pd
from google.oauth2 import service_account
from googleapiclient.discovery import build
import os

# Configuration
SHEET_ID = '1gZt-roARc3L27nEOlZdGwMHcwbcwf5rI9bAk7qpo8so'
SHEET_NAME = 'Sheet1'
SERVICE_ACCOUNT_FILE = './private/google-service-account.json'
CSV_FILE = '../thing.csv'

# Google Sheets API scope
SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

def format_customer_name(name):
    """Convert customer name to lowercase-hyphenated format"""
    if pd.isna(name):
        return ''
    
    # Convert to string and lowercase
    formatted = str(name).lower()
    
    # Replace spaces with hyphens
    formatted = formatted.replace(' ', '-')
    
    # Remove any trailing hyphens
    formatted = formatted.rstrip('-')
    
    # Replace multiple consecutive hyphens with single hyphen
    while '--' in formatted:
        formatted = formatted.replace('--', '-')
    
    return formatted

def main():
    # Read CSV
    df = pd.read_csv(CSV_FILE)
    
    # Prepare data for upload
    data = []
    for _, row in df.iterrows():
        formatted_name = format_customer_name(row['Fleet Advisor'])
        account_number = str(row['Unnamed: 1']) if not pd.isna(row['Unnamed: 1']) else ''
        email = str(row['Unnamed: 2']) if not pd.isna(row['Unnamed: 2']) else ''
        
        data.append([formatted_name, account_number, email])
    
    # Authenticate with Google Sheets
    credentials = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, 
        scopes=SCOPES
    )
    
    service = build('sheets', 'v4', credentials=credentials)
    sheet = service.spreadsheets()
    
    # Clear existing data (except header row)
    clear_range = f'{SHEET_NAME}!A2:C'
    sheet.values().clear(
        spreadsheetId=SHEET_ID,
        range=clear_range
    ).execute()
    
    # Upload new data starting from row 2
    if data:
        body = {
            'values': data
        }
        
        result = sheet.values().update(
            spreadsheetId=SHEET_ID,
            range=f'{SHEET_NAME}!A2',
            valueInputOption='RAW',
            body=body
        ).execute()
        
        print(f"Updated {result.get('updatedCells')} cells")
        print(f"Uploaded {len(data)} rows to Google Sheets")
    else:
        print("No data to upload")

if __name__ == '__main__':
    main()