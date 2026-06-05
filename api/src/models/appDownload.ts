import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';

interface AppDownloadAttributes {
  id: string;
  platform: 'macos' | 'windows';
  count: number;
}

interface AppDownloadCreationAttributes extends Optional<AppDownloadAttributes, 'id' | 'count'> {}

export class AppDownload
  extends Model<AppDownloadAttributes, AppDownloadCreationAttributes>
  implements AppDownloadAttributes
{
  public id!: string;
  public platform!: 'macos' | 'windows';
  public count!: number;
}

AppDownload.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
      defaultValue: () => cuid(),
    },
    platform: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    count: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'app_downloads',
    modelName: 'AppDownload',
  },
);
