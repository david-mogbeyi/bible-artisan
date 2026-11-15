import { Injectable } from '@nestjs/common';
import { literal, Op } from 'sequelize';
import { ExportFile } from '../../database/models/export-file.model';

/**
 * Deletes export files past their 24-hour expiry (BIB-47; PRD section 24), by the database clock.
 * They already read as absent (404) from that moment; this removes their content. Idempotent; the
 * worker runs it with the privacy purge. Account deletion removes an account's exports with the
 * user row (`export_file.owner_id` cascades).
 */
@Injectable()
export class ExportPurgeService {
  async purgeExpired(): Promise<number> {
    return ExportFile.destroy({ where: { expiresAt: { [Op.lte]: literal('now()') } } });
  }
}
