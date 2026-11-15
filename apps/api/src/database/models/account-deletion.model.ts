import { fn } from 'sequelize';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `account_deletion` (BIB-48, migration 20261115140001): the deletion
 * tombstone of one account. Holds the opaque user id and timestamps only, and has no foreign key
 * to `user`, so it outlives the purge and is reapplied to any user row a backup restore brings
 * back. CHECK: `purged_at` is not before `requested_at`. Identity owns this table.
 */
@Table({ tableName: 'account_deletion', timestamps: false })
export class AccountDeletion extends Model {
  @PrimaryKey
  @Column({ field: 'user_id', type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({
    field: 'requested_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: fn('now'),
  })
  declare requestedAt: Date;

  @Column({ field: 'purged_at', type: DataType.DATE, allowNull: true })
  declare purgedAt: Date | null;
}
