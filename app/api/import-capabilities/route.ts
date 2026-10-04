import { NextResponse } from 'next/server';

export const IMPORT_SCHEMA_VERSION = '1.0.0';

export interface ImportCapabilities {
  schema_version: string;
  supported: {
    identity: boolean;
    description: boolean;
    avatar: boolean;
    verification: boolean;
  };
  unsupported: {
    memories: boolean;
    skills: boolean;
    routines: boolean;
    integrations: boolean;
  };
}

export async function GET() {
  const capabilities: ImportCapabilities = {
    schema_version: IMPORT_SCHEMA_VERSION,
    supported: {
      identity: true,
      description: true,
      avatar: true,
      verification: true,
    },
    unsupported: {
      memories: true,
      skills: true,
      routines: true,
      integrations: true,
    },
  };

  return NextResponse.json(capabilities);
}
