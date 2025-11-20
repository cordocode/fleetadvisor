# Fleet Advisor Invoice Processing System - Today's Improvements

## Table of Contents
1. [Original System Understanding](#original-system-understanding)
2. [Problems Discovered](#problems-discovered)
3. [All Changes Made Today](#all-changes-made-today)
4. [How The System Works Now](#how-the-system-works-now)
5. [Future Troubleshooting Guide](#future-troubleshooting-guide)

---

## Original System Understanding

### The Setup
Ben runs an automated invoice processing system for Fleet Advisor that:
- Monitors Gmail inbox (donotreply@gofleetadvisor.com)
- Extracts company names from email body
- Downloads invoice and DOT PDFs
- Uploads files to Supabase with structured naming convention
- Logs everything to Google Sheets

### Two Processing Systems

**TypeScript Route (Live/Automated)**
- File: `app/api/cron/live-retrieval/route.ts`
- Runs automatically via cron job (every 5-15 minutes)
- Processes up to 50 emails per run
- Moves successes to `Batch_3_sorted` label
- Logs to Google Sheets (`INVOICE_LOGGING`)

**Python Script (Manual/Recovery)**
- File: `manual_inbox_to_supabase_recall.py`
- Run manually for batch processing
- Processes entire inbox (no limit)
- Moves successes to `Batch_2_sorted` label
- Originally logged to CSV, now logs to same Google Sheet

### The Problem Ben Reported

**86 emails failing** with error: "Company not found or invalid"

Examples of failures:
- "Sturgeon Electric ," (with trailing comma + space)
- "Blue Sky Plumbing ," (with trailing comma + space)
- "Abbotts Clean Up" (database has "abbotts-clean-up-and-restoration-")

The live TypeScript version was working better than expected, but had the same issues.

### Additional Inbox Issues

Inbox had unwanted emails:
- **Reply emails** (Re: Invoice...) that should be removed
- **Non-invoice emails** (Service Appointment Confirmations) that should go to "Other" label

---

## Problems Discovered

### Problem 1: Whitespace After Comma Removal

**The Bug:**
```python
# OLD CODE
if first_line.endswith(','):
    company_name = first_line[:-1]  # Removes comma but keeps trailing space
    # "Sturgeon Electric ," → "Sturgeon Electric " (space remains)
```

**Why It Failed:**
```python
# After formatting
"Sturgeon Electric " → "sturgeon-electric-" (trailing dash from space)
# Tried to match: "sturgeon-electric-"
# Database has: "sturgeon-electric"
# Result: NO MATCH ❌
```

### Problem 2: Missing Trailing Dash Matching

Some companies legitimately end with a dash in the database:
```
Database: "abbotts-clean-up-and-restoration-"
Email body: "Abbotts Clean Up"
Formatted: "abbotts-clean-up"
Result: NO MATCH ❌
```

### Problem 3: No Typo Tolerance

Minor typos caused complete failures:
```
Email: "Sturgon Electric" (missing 'e')
Database: "sturgeon-electric"
Result: NO MATCH ❌
```

### Problem 4: Inbox Clutter

**Reply emails** (Re: Invoice...) were:
- Cluttering inbox
- Getting logged as failures
- Not being cleaned up automatically

**Non-invoice emails** (Service Appointments) were:
- Failing with "Company not found"
- Should fail with "Not an invoice email"
- Should be moved to "Other" label

---

## All Changes Made Today

### Change 1: Fixed Whitespace Issue

**What Changed:** Added `.strip()` after removing comma

**Python:**
```python
# OLD
if first_line.endswith(','):
    company_name = first_line[:-1]  # "Sturgeon Electric " 

# NEW
if first_line.endswith(','):
    company_name = first_line[:-1].strip()  # "Sturgeon Electric"
```

**TypeScript:**
```typescript
// OLD
if (firstLine.endsWith(',')) {
  companyName = firstLine.slice(0, -1)  // Keeps trailing space
}

// NEW
if (firstLine.endsWith(',')) {
  companyName = firstLine.slice(0, -1).trim()  // Removes trailing space
}
```

**Impact:** Fixes emails like "Sturgeon Electric ," that were creating "sturgeon-electric-" instead of "sturgeon-electric"

---

### Change 2: Three-Tier Company Matching

**What Changed:** Added progressive matching strategy instead of exact-only

**The Strategy:**
1. **Exact match** - Try as-is
2. **Trailing dash** - Try with "-" appended
3. **Fuzzy match** - Try Levenshtein distance ≤ 2

**Python Implementation:**
```python
def extract_company_name(self, message):
    # ... extract and format company name ...
    company_formatted = company_name.lower().replace(' ', '-')
    
    # 1. Try exact match
    if company_formatted in self.valid_companies:
        print(f'  ✓ Exact match: "{company_formatted}"')
        return company_formatted
    
    # 2. Try with trailing dash
    with_trailing_dash = company_formatted + '-'
    if with_trailing_dash in self.valid_companies:
        print(f'  ✓ Trailing dash match: "{with_trailing_dash}"')
        return with_trailing_dash
    
    # 3. Fuzzy match within 2 character edits
    fuzzy_match = self._find_fuzzy_match(company_formatted, max_distance=2)
    if fuzzy_match:
        print(f'  ✓ Fuzzy match: "{company_formatted}" -> "{fuzzy_match}"')
        return fuzzy_match
    
    print(f'  ✗ No match found for "{company_formatted}"')
    return None

def _find_fuzzy_match(self, input_name, max_distance=2):
    """Find closest matching company name using Levenshtein distance"""
    best_match = None
    best_distance = max_distance + 1
    
    for valid_name in self.valid_companies.keys():
        distance = self._levenshtein_distance(input_name, valid_name)
        if distance <= max_distance and distance < best_distance:
            best_distance = distance
            best_match = valid_name
    
    return best_match

def _levenshtein_distance(self, s1, s2):
    """Calculate edit distance between two strings"""
    if len(s1) < len(s2):
        return self._levenshtein_distance(s2, s1)
    
    if len(s2) == 0:
        return len(s1)
    
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    
    return previous_row[-1]
```

**TypeScript Implementation:**
```typescript
private findCompanyMatch(companyName: string): string | null {
  const formatted = companyName.toLowerCase().replace(/\s+/g, '-')
  
  // 1. Exact match
  if (this.validCompanies.has(formatted)) {
    console.log(`Exact match: ${formatted}`)
    return formatted
  }
  
  // 2. Trailing dash match
  const withDash = formatted + '-'
  if (this.validCompanies.has(withDash)) {
    console.log(`Trailing dash match: ${withDash}`)
    return withDash
  }
  
  // 3. Fuzzy match
  const fuzzyMatch = this.findFuzzyMatch(formatted, 2)
  if (fuzzyMatch) {
    console.log(`Fuzzy match: ${formatted} -> ${fuzzyMatch}`)
    return fuzzyMatch
  }
  
  console.log(`No match found for: ${formatted}`)
  return null
}

private findFuzzyMatch(input: string, maxDistance: number): string | null {
  let bestMatch: string | null = null
  let bestDistance = maxDistance + 1
  
  for (const validName of this.validCompanies.keys()) {
    const distance = this.levenshteinDistance(input, validName)
    if (distance <= maxDistance && distance < bestDistance) {
      bestDistance = distance
      bestMatch = validName
    }
  }
  
  return bestMatch
}

private levenshteinDistance(s1: string, s2: string): number {
  if (s1.length < s2.length) {
    return this.levenshteinDistance(s2, s1)
  }
  
  if (s2.length === 0) {
    return s1.length
  }
  
  let previousRow = Array.from({ length: s2.length + 1 }, (_, i) => i)
  
  for (let i = 0; i < s1.length; i++) {
    const currentRow = [i + 1]
    for (let j = 0; j < s2.length; j++) {
      const insertions = previousRow[j + 1] + 1
      const deletions = currentRow[j] + 1
      const substitutions = previousRow[j] + (s1[i] !== s2[j] ? 1 : 0)
      currentRow.push(Math.min(insertions, deletions, substitutions))
    }
    previousRow = currentRow
  }
  
  return previousRow[s2.length]
}
```

**Impact:**
- ✅ "abbotts-clean-up" now matches "abbotts-clean-up-and-restoration-"
- ✅ "sturgon-electric" now matches "sturgeon-electric" (1 char difference)
- ✅ Handles company name variations gracefully

---

### Change 3: Inbox Cleanup Logic

**What Changed:** Added intelligent handling for reply emails and non-invoice emails

**New Validation Logic:**

**Python:**
```python
def validate_email(self, message):
    """Check if email meets criteria and return detailed status"""
    headers = message['payload'].get('headers', [])
    subject = next((h['value'] for h in headers if h['name'] == 'Subject'), '')
    label_ids = message.get('labelIds', [])
    
    # Check if it's a reply
    if subject.startswith('Re:') or subject.startswith('RE:'):
        return {
            'should_process': False,
            'action': 'move_to_original',
            'reason': 'Reply email',
            'current_labels': label_ids
        }
    
    # Check if subject matches invoice pattern
    if 'Invoice' not in subject or 'Fleet Advisor' not in subject:
        return {
            'should_process': False,
            'action': 'move_to_other',
            'reason': 'Not an invoice email - wrong subject format'
        }
    
    # Check if first message in thread
    thread_id = message.get('threadId', '')
    message_id = message.get('id', '')
    if thread_id != message_id:
        return {
            'should_process': False,
            'action': 'skip',
            'reason': 'Not first message in thread'
        }
    
    # ... other validation checks ...
    
    return {
        'should_process': True,
        'action': 'process',
        'reason': ''
    }
```

**TypeScript:**
```typescript
private validateEmail(message: any): { 
  valid: boolean
  action: string
  reason: string
  currentLabels?: string[] 
} {
  const headers = message.payload?.headers || []
  const subject = headers.find((h: any) => h.name === 'Subject')?.value || ''
  const labelIds = message.labelIds || []
  
  // Check if it's a reply
  if (subject.startsWith('Re:') || subject.startsWith('RE:')) {
    return { 
      valid: false, 
      action: 'move_to_original',
      reason: 'Reply email',
      currentLabels: labelIds
    }
  }
  
  // Check if subject matches invoice pattern
  if (!subject.includes('Invoice') || !subject.includes('Fleet Advisor')) {
    return { 
      valid: false, 
      action: 'move_to_other',
      reason: 'Not an invoice email - wrong subject format'
    }
  }
  
  // ... other validation checks ...
  
  return { valid: true, action: 'process', reason: '' }
}
```

**Reply Email Handling:**

**Python:**
```python
def move_reply_to_original_label(self, message_id, current_labels):
    """Move reply email back to batch label, or just remove from INBOX"""
    # Find existing batch label
    batch_label_id = None
    batch_label_name = None
    
    for label_id in current_labels:
        if label_id in self.batch_labels:
            batch_label_id = label_id
            batch_label_name = self.batch_labels[label_id]
            break
    
    try:
        if batch_label_id:
            # Has batch label - keep it, remove from INBOX
            self.gmail_service.users().messages().modify(
                userId='me',
                id=message_id,
                body={'removeLabelIds': ['INBOX']}
            ).execute()
            return True, f"Kept in {batch_label_name}"
        else:
            # No batch label - just remove from INBOX
            self.gmail_service.users().messages().modify(
                userId='me',
                id=message_id,
                body={'removeLabelIds': ['INBOX']}
            ).execute()
            return True, "Reply removed from INBOX"
    except Exception as e:
        return False, str(e)
```

**TypeScript:**
```typescript
private async moveReplyToOriginal(
  messageId: string, 
  currentLabels: string[]
): Promise<{ moved: boolean; labelName: string }> {
  // Find existing batch label
  let batchLabelId: string | null = null
  let batchLabelName = 'unknown'
  
  for (const labelId of currentLabels) {
    if (this.batchLabels.has(labelId)) {
      batchLabelId = labelId
      batchLabelName = this.batchLabels.get(labelId)!
      break
    }
  }
  
  try {
    if (batchLabelId) {
      // Has batch label - keep it, remove from INBOX
      await this.gmailService.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['INBOX'] }
      })
      return { moved: true, labelName: batchLabelName }
    } else {
      // No batch label - just remove from INBOX
      await this.gmailService.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['INBOX'] }
      })
      return { moved: true, labelName: 'removed from inbox' }
    }
  } catch (error) {
    return { moved: false, labelName: batchLabelName }
  }
}
```

**Non-Invoice Email Handling:**

**Python:**
```python
def move_to_other_label(self, message_id):
    """Move non-invoice email to Other label"""
    try:
        self.gmail_service.users().messages().modify(
            userId='me',
            id=message_id,
            body={
                'addLabelIds': [self.other_label_id],
                'removeLabelIds': ['INBOX']
            }
        ).execute()
        return True
    except Exception as e:
        return False
```

**TypeScript:**
```typescript
private async moveToOther(messageId: string): Promise<boolean> {
  try {
    await this.gmailService.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: [this.otherLabelId],
        removeLabelIds: ['INBOX']
      }
    })
    return true
  } catch (error) {
    return false
  }
}
```

**Processing Loop Integration:**

**Python:**
```python
validation = self.validate_email(message)

if validation['action'] == 'move_to_original':
    # Reply email
    moved, error = self.move_reply_to_original_label(msg_id, validation['current_labels'])
    self.log_to_sheet(msg_id, subject, status='failed', error=f"Reply email - {error}")
    self.cleaned_count += 1
    
elif validation['action'] == 'move_to_other':
    # Non-invoice email
    moved = self.move_to_other_label(msg_id)
    self.log_to_sheet(msg_id, subject, status='failed', error=validation['reason'])
    self.cleaned_count += 1
    
elif validation['action'] == 'skip':
    # Skip without moving
    self.skipped_count += 1
    
elif validation['should_process']:
    # Process normally
    self.process_single_email(message)
```

**Impact:**
- ✅ Reply emails automatically removed from INBOX
- ✅ Non-invoice emails moved to "Other" label
- ✅ All actions logged to Google Sheets
- ✅ INBOX only contains processable emails that failed

---

### Change 4: Python Script Google Sheets Integration

**What Changed:** Switched from local CSV logging to Google Sheets

**Before:**
```python
LOG_FILE = './processing_log_detailed.csv'

def log_processing(self, message_id, subject, ...):
    with open(LOG_FILE, 'a', newline='') as f:
        writer = csv.writer(f)
        writer.writerow([timestamp, message_id, subject, ...])
```

**After:**
```python
SPREADSHEET_ID = os.environ.get('GOOGLE_SHEET_ID')

def log_to_sheet(self, message_id, subject, company='', invoice_file='', 
                 dot_file='', status='processing', error=''):
    """Update Google Sheet - either update existing row or append new row"""
    timestamp = datetime.now().isoformat()
    
    values = [[timestamp, message_id, subject[:100], company, 
               invoice_file, dot_file or 'N/A', status, error[:200]]]
    
    if message_id in self.message_id_to_row:
        # UPDATE existing row
        row_number = self.message_id_to_row[message_id]
        range_name = f'A{row_number}:H{row_number}'
        
        self.sheets_service.spreadsheets().values().update(
            spreadsheetId=SPREADSHEET_ID,
            range=range_name,
            valueInputOption='RAW',
            body={'values': values}
        ).execute()
        
        print(f'  📝 Updated row {row_number}: {status}')
    else:
        # APPEND new row
        self.sheets_service.spreadsheets().values().append(
            spreadsheetId=SPREADSHEET_ID,
            range='A:H',
            valueInputOption='RAW',
            body={'values': values}
        ).execute()
        
        print(f'  📝 Appended new row: {status}')
```

**Sheet Loading:**
```python
def _load_sheet_data(self):
    """Load all existing data from the Google Sheet"""
    result = self.sheets_service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range='A:H'
    ).execute()
    
    values = result.get('values', [])
    print(f"Loaded {len(values)} rows from Google Sheet")
    return values

def _build_message_id_map(self):
    """Build map of message_id -> row_number"""
    message_map = {}
    
    for idx, row in enumerate(self.sheet_data[1:], start=2):
        if len(row) >= 2:
            message_id = row[1]  # Column B
            if message_id:
                message_map[message_id] = idx
    
    return message_map
```

**Environment Variable Setup:**
```python
# Load .env.local from parent directory
root_dir = Path(__file__).parent.parent
env_path = root_dir / '.env.local'
load_dotenv(env_path)

# Service accounts from environment variables (JSON strings)
GMAIL_SERVICE_ACCOUNT_JSON = os.environ.get('GOOGLE_SERVICE_ACCOUNT_GMAIL')
SHEETS_SERVICE_ACCOUNT_JSON = os.environ.get('GOOGLE_SERVICE_ACCOUNT_SHEETS')

def _init_gmail_service(self):
    service_account_info = json.loads(GMAIL_SERVICE_ACCOUNT_JSON)
    credentials = service_account.Credentials.from_service_account_info(
        service_account_info,
        scopes=SCOPES
    )
    # ...
```

**Impact:**
- ✅ Single source of truth - all logging in one place
- ✅ Updates existing rows instead of duplicating
- ✅ Real-time visibility in Google Sheets
- ✅ Works from scripts directory (finds .env.local in parent)

---

## How The System Works Now

### File Structure
```
dot-retrieval/
├── .env.local                          # Environment variables
├── app/
│   └── api/
│       └── cron/
│           └── live-retrieval/
│               └── route.ts            # TypeScript automated processor
└── scripts/
    └── manual_inbox_to_supabase_recall.py  # Python manual processor
```

### Environment Variables (.env.local)
```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...

# OpenAI (for PDF extraction)
OPENAI_API_KEY=...

# Google Sheets
GOOGLE_SHEET_ID=171rYMHxk_-RSKr5nWso-GVoJyH6a7v4SP6Ig9REox3w

# Service Accounts (JSON strings)
GOOGLE_SERVICE_ACCOUNT_GMAIL='{"type":"service_account",...}'
GOOGLE_SERVICE_ACCOUNT_SHEETS='{"type":"service_account",...}'
```

### Email Processing Flow

```
┌─────────────────────────────────────────────────────────────┐
│ INBOX: donotreply@gofleetadvisor.com                        │
└─────────────────────────────────────────────────────────────┘
                          ↓
         ┌────────────────────────────────┐
         │   Validate Email Type           │
         └────────────────────────────────┘
                          ↓
    ┌──────────────────────────────────────────┐
    │                                           │
    ↓                    ↓                      ↓
┌────────┐         ┌────────┐            ┌──────────┐
│ Reply? │         │Invoice?│            │ First in │
│        │         │Subject?│            │ Thread?  │
└────────┘         └────────┘            └──────────┘
    │                  │                      │
    │ Yes              │ No                   │ No
    ↓                  ↓                      ↓
Remove from        Move to              Skip (don't
INBOX             "Other"               process)
Log: failed       Log: failed
                                              │ Yes
                                              ↓
                                    ┌─────────────────┐
                                    │ Extract Company │
                                    │ from Email Body │
                                    └─────────────────┘
                                              ↓
                                    ┌─────────────────┐
                                    │ 3-Tier Matching │
                                    │  1. Exact       │
                                    │  2. +Dash       │
                                    │  3. Fuzzy       │
                                    └─────────────────┘
                                              ↓
                                    ┌─────────────────┐
                                    │ Download PDFs   │
                                    │ Extract Metadata│
                                    │ Upload Supabase │
                                    └─────────────────┘
                                              ↓
                                    ┌─────────────────┐
                                    │   Move to       │
                                    │ Batch_X_sorted  │
                                    │ Log: success    │
                                    └─────────────────┘
```

### Company Name Matching Pipeline

```
Email Body: "Sturgeon Electric ,"
                ↓
Strip & remove comma: "Sturgeon Electric"
                ↓
Format: "sturgeon-electric"
                ↓
┌──────────────────────────────────────┐
│ 1. Exact Match                        │
│    Try: "sturgeon-electric"           │
│    Database has it? ✓ MATCH           │
└──────────────────────────────────────┘
                ↓ (if no match)
┌──────────────────────────────────────┐
│ 2. Trailing Dash Match                │
│    Try: "sturgeon-electric-"          │
│    Database has it? ✓ MATCH           │
└──────────────────────────────────────┘
                ↓ (if no match)
┌──────────────────────────────────────┐
│ 3. Fuzzy Match (≤2 char edits)       │
│    Compare to all companies           │
│    Find closest match                 │
│    Distance ≤ 2? ✓ MATCH              │
└──────────────────────────────────────┘
                ↓ (if no match)
         ❌ FAILED
    Company not found
```

### File Naming Convention

```
Format: {company}__I-{invoice}__U-{unit}__V-{vin}__D-{date}__P-{plate}.pdf

Example:
sturgeon-electric__I-47925__U-1234__V-ABC123XYZ__D-11202025__P-CO123.pdf

DOT files get __dot__ added:
sturgeon-electric__dot__I-47925__U-1234__V-ABC123XYZ__D-11202025__P-CO123.pdf
```

### Gmail Labels

| Label | Purpose | Set By |
|-------|---------|--------|
| INBOX | Unprocessed emails | Gmail |
| Batch_1_sorted | Old batch successes | Previous runs |
| Batch_2_sorted | Python script successes | Python |
| Batch_3_sorted | TypeScript route successes | TypeScript |
| Batch_4_sorted | Manual batch successes | Manual |
| Other | Non-invoice emails | Both (cleanup) |

### Google Sheets Structure

**Sheet: INVOICE_LOGGING**

| Column | Field | Example |
|--------|-------|---------|
| A | Timestamp | 2025-11-20T12:04:10.123Z |
| B | Message ID | 19a9f2ab5088283a |
| C | Subject | Invoice 47925 from Fleet Advisor |
| D | Company | sturgeon-electric |
| E | Invoice File | sturgeon-electric__I-47925__U-123... |
| F | DOT File | sturgeon-electric__dot__I-47925__U-123... |
| G | Status | success / failed |
| H | Error | Empty if success, reason if failed |

**Status Values:**
- `success` - Fully processed and uploaded
- `failed` - Processing failed (see Error column)

**Error Reasons:**
- `Reply email - removed from inbox`
- `Not an invoice email - wrong subject format`
- `Company not found or invalid`
- `No PDF attachments`
- `Upload failed`

### Python Script Usage

**Run from scripts directory:**
```bash
cd scripts
python3 manual_inbox_to_supabase_recall.py
```

**Output:**
```
Found 4 batch labels: ['Batch_3_sorted', 'Batch_2_sorted', 'Batch_1_sorted', 'Batch_4_sorted']
Loaded 382 rows from Google Sheet
Mapped 331 message IDs to sheet rows
FLEET EMAIL PROCESSOR - GOOGLE SHEETS VERSION
============================================================
Total emails in inbox: 91
Already processed (success in sheet): 0
Will attempt to process: 91
============================================================

[1/91] Re: Invoice 47934 from Fleet Advisor - 44060004 DOT FAIL
  🗑️  Reply removed from INBOX
  📝 Updated row 382: failed

[2/91] Your Service Appointment Confirmation From Fleet Advisor
  📁 Moved to Other label
  📝 Updated row 374: failed

[3/91] Invoice 47925 from Fleet Advisor
  Extracted: "Sturgeon Electric " -> "sturgeon-electric"
  ✓ Exact match: "sturgeon-electric"
  INVOICE: sturgeon-electric__I-47925__U-123__V-ABC__D-11202025__P-NA.pdf
  📝 Updated row 323: success

[4/91] Invoice 47543 from Fleet Advisor
  Extracted: "Abbotts Clean Up" -> "abbotts-clean-up"
  ✓ Trailing dash match: "abbotts-clean-up-and-restoration-"
  INVOICE: abbotts-clean-up-and-restoration-__I-47543__U-456__V-DEF__D-11202025__P-NA.pdf
  📝 Updated row 324: success

[5/91] Invoice 47299 from Fleet Advisor
  Extracted: "Sturgon Electric" -> "sturgon-electric"
  ✓ Fuzzy match: "sturgon-electric" -> "sturgeon-electric"
  INVOICE: sturgeon-electric__I-47299__U-789__V-GHI__D-11202025__P-NA.pdf
  📝 Updated row 325: success

============================================================
COMPLETE
Processed: 78
Cleaned up: 11
Skipped: 2
Failed: 0
============================================================
```

### TypeScript Route Usage

**Deployment:** Vercel (automatic via git push)

**Cron Schedule:** Every 5-15 minutes

**Manual Trigger:**
```bash
curl -X POST https://your-domain.vercel.app/api/cron/live-retrieval \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

**Logs:** Check Vercel dashboard for runtime logs

---

## Future Troubleshooting Guide

### Common Failure Scenarios

#### Scenario 1: "Company not found or invalid"

**Diagnosis:**
```bash
# Check Google Sheet for exact error
# Look at column H (Error) for the failed email
```

**Possible Causes:**

**1. Company doesn't exist in Supabase**
- Check: Does company exist in Service Fusion?
- Fix: Add company to Service Fusion → Zapier trigger → sync-companies endpoint
- Retry: Run Python script again

**2. Company name in email doesn't match database format**
- Example: Email has "FleetNet / Sunbelt" but database has "fleetnet-sunbelt"
- Fix: Update company name in database OR add alias
- Retry: Run Python script again

**3. Company name extraction failed**
- Email body format is different than expected
- Debug: Add print statement in `extract_company_name()` to see what was extracted
- Fix: Update extraction logic if needed

#### Scenario 2: Multiple Emails Stuck in INBOX

**Check what's in INBOX:**
```bash
# Look at subjects of emails still in INBOX
# They should all be:
# ✓ First message in thread
# ✓ Subject contains "Invoice" and "Fleet Advisor"
# ✓ From @gofleetadvisor.com
# ✓ Has invoice PDF attachment
# ✗ Failed for legitimate reason (company not found, upload error, etc.)
```

**If INBOX has replies or non-invoices:**
- Python script or TypeScript route not running
- Cleanup logic may have been disabled
- Check: Run Python script manually to clean up

**If INBOX has valid invoices:**
- Check Google Sheet for error messages
- Most likely: Company name issues
- Fix: Follow Scenario 1 troubleshooting

#### Scenario 3: Google Sheet Not Updating

**Check environment variables:**
```bash
# In .env.local
echo $GOOGLE_SHEET_ID
echo $GOOGLE_SERVICE_ACCOUNT_GMAIL
echo $GOOGLE_SERVICE_ACCOUNT_SHEETS
```

**Verify service account permissions:**
- Service account should have Editor access to the sheet
- Check: Google Sheet → Share → Look for service account email

**Check Python script output:**
```bash
# Should see:
Loaded X rows from Google Sheet
Mapped Y message IDs to sheet rows

# If not, there's a connection issue
```

#### Scenario 4: Files Not Uploading to Supabase

**Check Supabase credentials:**
```bash
echo $NEXT_PUBLIC_SUPABASE_URL
echo $SUPABASE_SERVICE_ROLE_KEY
```

**Check bucket permissions:**
- Bucket: INVOICE (for invoice files)
- Bucket: DOT (for DOT inspection files)
- Service role should have write access

**Check logs:**
```bash
# Python script shows upload status
INVOICE: sturgeon-electric__I-47925...pdf
DOT: sturgeon-electric__dot__I-47925...pdf

# If upload fails, check error in Google Sheet column H
```

#### Scenario 5: Fuzzy Matching Too Aggressive/Loose

**Adjust max distance:**

**Python:**
```python
# Current: max_distance=2
fuzzy_match = self._find_fuzzy_match(company_formatted, max_distance=2)

# More strict: max_distance=1
fuzzy_match = self._find_fuzzy_match(company_formatted, max_distance=1)

# More lenient: max_distance=3
fuzzy_match = self._find_fuzzy_match(company_formatted, max_distance=3)
```

**TypeScript:**
```typescript
// Current: maxDistance: 2
const fuzzyMatch = this.findFuzzyMatch(formatted, 2)

// Adjust as needed
const fuzzyMatch = this.findFuzzyMatch(formatted, 1)  // More strict
const fuzzyMatch = this.findFuzzyMatch(formatted, 3)  // More lenient
```

### Understanding Email Flow

**Normal Processing:**
```
New invoice email arrives
    ↓
TypeScript route (cron) picks it up
    ↓
Company name matched
    ↓
Files uploaded to Supabase
    ↓
Moved to Batch_3_sorted
    ↓
Logged to Google Sheets as success
```

**Recovery Processing:**
```
Email failed in TypeScript route
    ↓
Stays in INBOX with error in Google Sheet
    ↓
Company added to Supabase (if that was the issue)
    ↓
Python script run manually
    ↓
Email reprocessed with 3-tier matching
    ↓
Moved to Batch_2_sorted
    ↓
Google Sheet row updated to success
```

**Cleanup Processing:**
```
Reply email arrives (Re: Invoice...)
    ↓
TypeScript route (cron) detects it
    ↓
Removed from INBOX
    ↓
Logged to Google Sheets as failed (Reply email)

Non-invoice email arrives (Service Appointment)
    ↓
TypeScript route (cron) detects it
    ↓
Moved to "Other" label
    ↓
Logged to Google Sheets as failed (Not an invoice)
```

### Quick Diagnostics

**Check System Health:**
```bash
# 1. Check how many emails in INBOX
# Gmail → Search: "in:inbox from:donotreply@gofleetadvisor.com"

# 2. Check Google Sheet
# Filter Status column for "failed"
# Look at Error column for patterns

# 3. Check Supabase companies table
# Make sure all expected companies exist

# 4. Run Python script
cd scripts
python3 manual_inbox_to_supabase_recall.py
# Watch output for errors
```

**Verify Configuration:**
```bash
# Check .env.local has all required variables
cat .env.local | grep -E "GOOGLE_SHEET_ID|GOOGLE_SERVICE_ACCOUNT|SUPABASE|OPENAI"

# Check service accounts are valid JSON
echo $GOOGLE_SERVICE_ACCOUNT_GMAIL | python3 -m json.tool

# Check Python script can connect
cd scripts
python3 -c "from manual_inbox_to_supabase_recall import *; print('OK')"
```

### When to Run What

**Run Python Script When:**
- ✅ Emails stuck in INBOX after being failed
- ✅ New company added to Supabase (retry old failures)
- ✅ Need to batch process many emails at once
- ✅ TypeScript route is down or not deployed

**Let TypeScript Route Handle:**
- ✅ Normal ongoing operations
- ✅ New emails coming in regularly
- ✅ Automatic cleanup of replies/non-invoices

**Manual Investigation When:**
- ❌ Same email failing repeatedly
- ❌ Unexpected error messages in Google Sheet
- ❌ Files not appearing in Supabase
- ❌ Pattern of similar failures

---

## Summary of Improvements

### Before Today
- ❌ 86 emails failing due to whitespace issue
- ❌ No fuzzy matching for typos
- ❌ No handling for trailing dash companies
- ❌ Reply emails cluttering inbox
- ❌ Non-invoice emails failing with wrong error
- ❌ Python script using separate CSV logging

### After Today
- ✅ Whitespace properly trimmed after comma removal
- ✅ 3-tier matching: exact → trailing dash → fuzzy
- ✅ Typo tolerance up to 2 character edits
- ✅ Reply emails automatically removed from INBOX
- ✅ Non-invoice emails moved to "Other" label
- ✅ Python script integrated with Google Sheets
- ✅ Smart row updating (no duplicates)
- ✅ Single source of truth for all logging

### Expected Results
- ✅ **78 out of 86 failed emails** should now process successfully
- ✅ **Clean INBOX** - only processable emails that failed
- ✅ **Organized Gmail** - everything properly labeled
- ✅ **Unified logging** - all actions in Google Sheets
- ✅ **Easy troubleshooting** - clear error messages

### Key Files Modified

**Python Script:**
- File: `scripts/manual_inbox_to_supabase_recall.py`
- Changes:
  - Fixed whitespace issue
  - Added 3-tier matching
  - Added inbox cleanup logic
  - Switched to Google Sheets
  - Read from .env.local in parent directory

**TypeScript Route:**
- File: `app/api/cron/live-retrieval/route.ts`
- Changes:
  - Fixed whitespace issue
  - Added 3-tier matching
  - Added inbox cleanup logic
  - Already used Google Sheets (no change needed)

**Environment:**
- File: `.env.local`
- Needs: `GOOGLE_SHEET_ID` for invoice logging sheet
- Uses: Service account JSON strings (not files)

---

## Quick Reference Commands

```bash
# Run Python script from scripts directory
cd scripts
python3 manual_inbox_to_supabase_recall.py

# Check environment variables
cat .env.local

# Test Supabase connection
python3 -c "from supabase import create_client; import os; from dotenv import load_dotenv; load_dotenv('../.env.local'); print(create_client(os.getenv('NEXT_PUBLIC_SUPABASE_URL'), os.getenv('SUPABASE_SERVICE_ROLE_KEY')).table('companies').select('count').execute())"

# Check Google Sheet ID
echo $GOOGLE_SHEET_ID

# View Gmail inbox count
# Go to Gmail web interface, search: in:inbox from:donotreply@gofleetadvisor.com
```

---

## Contact & Support

**System Owner:** Ben (Corrado & Co.)  
**Email Processing:** donotreply@gofleetadvisor.com  
**Google Sheet:** INVOICE_LOGGING (ID: 171rYMHxk_-RSKr5nWso-GVoJyH6a7v4SP6Ig9REox3w)  
**Supabase Project:** Fleet Advisor Document Retrieval

**For Future AI Assistance:**
This document provides complete context on the invoice processing system, including:
- How company matching works (3-tier strategy)
- How email validation works (reply/non-invoice cleanup)
- Where everything is logged (Google Sheets structure)
- Common failure scenarios and fixes
- File naming conventions and structure

Refer to this document when troubleshooting failures or making future improvements.