// src/database/client/ConnectionManager.ts

import { DatabaseConnection, DatabaseConfig, ConnectionStats } from '../types/database.types';
import { CSDatabaseAdapter } from '../adapters/DatabaseAdapter';
import { ConnectionPool } from './ConnectionPool';
import { CSReporter } from '../../reporter/CSReporter';

export class ConnectionManager {
  private adapter: CSDatabaseAdapter;
  private connection?: DatabaseConnection;
  private pool?: ConnectionPool;
  private config?: DatabaseConfig;
  private healthCheckInterval?: NodeJS.Timeout;
  private lastHealthCheck: Date = new Date();
  private healthy: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;

  constructor(adapter: CSDatabaseAdapter) {
    this.adapter = adapter;
  }

  async connect(config: DatabaseConfig): Promise<DatabaseConnection> {
    try {
      this.config = config;
      
      if (config.poolSize && config.poolSize > 1) {
        this.pool = new ConnectionPool(this.adapter, config);
        await this.pool.initialize();
        this.connection = await this.pool.acquire();
      } else {
        this.connection = await this.adapter.connect(config);
      }
      
      this.startHealthMonitoring();
      this.healthy = true;
      this.reconnectAttempts = 0;
      
      return this.connection;
    } catch (error) {
      CSReporter.error('Connection failed: ' + (error as Error).message);
      throw error;
    }
  }

  async getConnection(): Promise<DatabaseConnection> {
    if (!this.connection) {
      throw new Error('No active database connection');
    }

    if (!this.healthy) {
      await this.attemptReconnect();
    }

    if (this.pool) {
      return this.pool.acquire();
    }

    return this.connection;
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    if (this.pool) {
      await this.pool.release(connection);
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.stopHealthMonitoring();

      if (this.pool) {
        await this.pool.drain();
      } else if (this.connection) {
        await this.adapter.disconnect(this.connection);
      }

      delete (this as any).connection;
      delete (this as any).pool;
      this.healthy = false;
      
    } catch (error) {
      CSReporter.error('Disconnect failed: ' + (error as Error).message);
      throw error;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      if (!this.connection && !this.pool) {
        return false;
      }

      const testConnection = this.pool ? await this.pool.acquire() : this.connection!;
      
      try {
        await this.adapter.ping(testConnection);
        this.lastHealthCheck = new Date();
        this.healthy = true;
        return true;
      } finally {
        if (this.pool) {
          await this.pool.release(testConnection);
        }
      }
    } catch (error) {
      CSReporter.warn('Health check failed: ' + (error as Error).message);
      this.healthy = false;
      return false;
    }
  }

  isHealthy(): boolean {
    const thirtySecondsAgo = new Date(Date.now() - 30000);
    return this.healthy && this.lastHealthCheck > thirtySecondsAgo;
  }

  getPoolStats(): ConnectionStats | null {
    if (!this.pool) {
      return null;
    }

    return this.pool.getStats();
  }

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      const healthy = await this.checkHealth();
      
      if (!healthy && this.config) {
        CSReporter.warn('Health check failed for database connection');
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          await this.attemptReconnect();
        }
      }
    }, 10000);

    this.checkHealth();
  }

  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        delete (this as any).healthCheckInterval;
      }
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration available for reconnection');
    }

    this.reconnectAttempts++;
    CSReporter.info(`Attempting to reconnect (attempt ${this.reconnectAttempts})`);

    try {
      if (this.connection) {
        try {
          await this.adapter.disconnect(this.connection);
        } catch (error) {
        }
      }

      if (this.pool) {
        await this.pool.reconnect();
        this.connection = await this.pool.acquire();
      } else {
        this.connection = await this.adapter.connect(this.config);
      }

      this.healthy = true;
      this.reconnectAttempts = 0;
      CSReporter.info('Database reconnection successful');
      
    } catch (error) {
      CSReporter.error('Reconnect failed: ' + (error as Error).message);
      
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.stopHealthMonitoring();
        throw new Error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`);
      }
      
      const waitTime = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  async executeWithConnection<T>(
    operation: (connection: DatabaseConnection) => Promise<T>
  ): Promise<T> {
    const connection = await this.getConnection();
    
    try {
      return await operation(connection);
    } finally {
      await this.releaseConnection(connection);
    }
  }

  getAdapter(): CSDatabaseAdapter {
    return this.adapter;
  }
}
