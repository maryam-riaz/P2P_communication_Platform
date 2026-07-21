import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class SosReport extends Model {
  static table = 'sos_reports';

  @field('sender_id') senderId!: string;
  @field('title') title!: string;
  @field('description') description!: string;
  @field('latitude') latitude!: number;
  @field('longitude') longitude!: number;
  @field('severity') severity!: 'low' | 'medium' | 'high' | 'critical';
  @field('status') status!: 'open' | 'acknowledged' | 'resolved';
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}
