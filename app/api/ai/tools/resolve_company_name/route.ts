// tools/resolve_company_name.ts
// FULL DROP-IN REPLACEMENT with robust origin resolution + logging.
// Works both locally and on Vercel/custom domain (NEXT_PUBLIC_SITE_URL).

type ResolveCompanyArgs = {
  userInput: string
  context?: {
    isAdmin?: boolean
    userCompany?: string
    [k: string]: unknown
  }
}

type Match = {
  name: string
  displayName: string
  confidence: number
}

type ResolveCompanyResponse =
  | {
      matchType: 'single' | 'multiple' | 'restricted' | 'none'
      matches: Match[]
      suggestions?: Match[]
      message?: string
      success?: boolean
      error?: string
    }
  | { success: false; error: string }

/**
 * Normalize a site URL: ensure it has protocol, strip trailing slash.
 */
function normalizeSiteUrl(raw?: string | null): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) {
    // If someone set it without protocol, assume https in prod
    s = `https://${s}`
  }
  return s.replace(/\/$/, '')
}

/**
 * Resolve the correct origin for server-side fetches.
 * Priority:
 * 1) NEXT_PUBLIC_SITE_URL (you set this to https://fleetadvisor.ai)
 * 2) VERCEL_URL (preview/prod host provided by Vercel)
 * 3) NEXT_PUBLIC_VERCEL_URL (sometimes folks use this)
 * 4) Local fallback
 */
function getOrigin(): string {
  const fromExplicit = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL)
  if (fromExplicit) return fromExplicit

  const vercelUrl = process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL
  if (vercelUrl) {
    const norm = normalizeSiteUrl(vercelUrl)
    if (norm) return norm
  }

  // Final fallback: local dev
  return 'http://localhost:3000'
}

/** Main export your tool runner should call. */
export async function resolve_company_name(args: ResolveCompanyArgs): Promise<ResolveCompanyResponse> {
  const origin = getOrigin()
  const url = `${origin}/api/ai/tools/resolve_company_name`

  // DEBUG LOGS: show exactly what this function will use in prod
  console.log('[resolve_company_name] origin:', origin)
  console.log('[resolve_company_name] env check:', {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ? 'set' : 'unset',
    VERCEL_URL: process.env.VERCEL_URL ? 'set' : 'unset',
    NEXT_PUBLIC_VERCEL_URL: process.env.NEXT_PUBLIC_VERCEL_URL ? 'set' : 'unset',
    NODE_ENV: process.env.NODE_ENV,
  })

  const res = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userInput: args.userInput,
      context: args.context ?? {},
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { success: false, error: `Request failed: ${res.status} ${res.statusText} ${text}` }
  }

  const data = (await res.json()) as ResolveCompanyResponse
  return data
}

// Optional default export if your loader expects it:
export default resolve_company_name
