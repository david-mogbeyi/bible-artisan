import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `operational_request_metric` (BIB-50, migration 20261115170000): HTTP
 * request counters for one minute, method and matched route pattern, summed across API processes.
 * Mirrors the migration by hand (no codegen):
 * - primary key `(bucket_start, method, route)`; `bucket_start` is a whole minute (CHECK);
 * - every status counter is between 0 and `request_count` (CHECK);
 * - `latency_histogram` has exactly 11 non-negative slots, one per `REQUEST_LATENCY_BOUNDS_MS`
 *   bound plus the overflow slot (CHECK).
 *
 * Content-free by construction: no owner, study or request data. Observability module owns this
 * table; the API writes it with a batched upsert and the worker reads and prunes it.
 */
@Table({ tableName: 'operational_request_metric', timestamps: false })
export class OperationalRequestMetric extends Model {
  @PrimaryKey
  @Column({ field: 'bucket_start', type: DataType.DATE, allowNull: false })
  declare bucketStart: Date;

  @PrimaryKey
  @Column({ type: DataType.TEXT, allowNull: false })
  declare method: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT, allowNull: false })
  declare route: string;

  @Column({ field: 'request_count', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare requestCount: number;

  @Column({
    field: 'server_error_count',
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
  })
  declare serverErrorCount: number;

  @Column({ field: 'conflict_count', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare conflictCount: number;

  @Column({
    field: 'unauthorized_count',
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
  })
  declare unauthorizedCount: number;

  @Column({ field: 'forbidden_count', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare forbiddenCount: number;

  @Column({ field: 'not_found_count', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare notFoundCount: number;

  @Column({ field: 'aborted_count', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare abortedCount: number;

  @Column({
    field: 'latency_histogram',
    type: DataType.ARRAY(DataType.INTEGER),
    allowNull: false,
  })
  declare latencyHistogram: number[];
}
