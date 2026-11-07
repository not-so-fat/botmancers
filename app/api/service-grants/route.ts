import { NextResponse } from 'next/server';
import { serviceAudit } from '@/lib/db';

// NOT-499: the owner's view of service access. NOT-556: there are no
// grants any more (a configured service token reaches every registered
// Agent), so this reports only the latest service audit events. Read-only;
// behind the owner boundary.
export async function GET() {
  try {
    return NextResponse.json({ audit: serviceAudit.list({ limit: 50 }) });
  } catch (error) {
    console.error('Error reading the service audit trail:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: { code: 'internal_error', message: 'The service audit trail could not be read.' } }, { status: 500 });
  }
}
