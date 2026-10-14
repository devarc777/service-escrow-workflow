import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient {
  // Intentionally avoid connecting on module init to prevent startup failure
  // when the database is not available. Prisma will attempt to connect on
  // first query; callers should handle errors gracefully.
}
