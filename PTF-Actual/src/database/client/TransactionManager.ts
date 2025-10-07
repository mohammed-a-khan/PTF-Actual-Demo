// src/database/client/TransactionManager.ts

import { DatabaseConnection, TransactionOptions, TransactionState } from '../types/database.types';
import { CSDatabaseAdapter } from '../adapters/DatabaseAdapter';
import { CSReporter } from '../../reporter/CSReporter';

export class TransactionManager {
  private adapter: CSDatabaseAdapter;
  private transactionStack: Map<DatabaseConnection, TransactionState[]> = new Map();
  private savepointCounter: number = 0;

  constructor(adapter: CSDatabaseAdapter) {
    this.adapter = adapter;
  }

  async begin(connection: DatabaseConnection, options?: TransactionOptions): Promise<void> {
    try {
      let stack = this.transactionStack.get(connection);
      if (!stack) {
        stack = [];
        this.transactionStack.set(connection, stack);
      }

      if (stack.length > 0) {
        const savepointName = this.generateSavepointName();
        await this.savepoint(connection, savepointName);
        
        stack.push({
          level: stack.length + 1,
          savepoint: savepointName,
          startTime: Date.now()
        });
      } else {
        await this.adapter.beginTransaction(connection, options);
        
        const transactionState: TransactionState = {
          level: 1,
          startTime: Date.now()
        };
        if (options?.isolationLevel) {
          transactionState.isolationLevel = options.isolationLevel;
        }
        stack.push(transactionState);
      }

      CSReporter.info(`Transaction started at level ${stack.length}${options?.isolationLevel ? ` with isolation: ${options.isolationLevel}` : ''}`);
      
    } catch (error) {
      CSReporter.error('Failed to begin transaction: ' + (error as Error).message);
      throw error;
    }
  }

  async commit(connection: DatabaseConnection): Promise<void> {
    try {
      const stack = this.transactionStack.get(connection);
      if (!stack || stack.length === 0) {
        throw new Error('No active transaction to commit');
      }

      const current = stack.pop()!;
      const duration = Date.now() - current.startTime;

      if (stack.length === 0) {
        await this.adapter.commitTransaction(connection);
        this.transactionStack.delete(connection);
        
        CSReporter.info(`Transaction committed at level ${current.level} (duration: ${duration}ms)`);
      } else {
        if (current.savepoint) {
          await this.releaseSavepoint(connection, current.savepoint);
        }
        
        CSReporter.info(`Savepoint released: ${current.savepoint} at level ${current.level} (duration: ${duration}ms)`);
      }
      
    } catch (error) {
      CSReporter.error('Failed to commit transaction: ' + (error as Error).message);
      throw error;
    }
  }

  async rollback(connection: DatabaseConnection, savepoint?: string): Promise<void> {
    try {
      const stack = this.transactionStack.get(connection);
      
      if (!stack || stack.length === 0) {
        throw new Error('No active transaction to rollback');
      }

      if (savepoint) {
        await this.rollbackToSavepoint(connection, savepoint);
        
        const index = stack.findIndex(state => state.savepoint === savepoint);
        if (index !== -1) {
          stack.splice(index);
        }
        
        CSReporter.info(`Savepoint rollback: ${savepoint}, remaining levels: ${stack.length}`);
      } else {
        const current = stack[stack.length - 1];
        if (!current) {
          throw new Error('Invalid transaction state');
        }
        
        if (stack.length === 1) {
          await this.adapter.rollbackTransaction(connection);
          this.transactionStack.delete(connection);
          
          CSReporter.info(`Transaction rolled back at level ${current.level} (duration: ${Date.now() - current.startTime}ms)`);
        } else {
          stack.pop();
          const previous = stack[stack.length - 1];
          
          if (previous && previous.savepoint) {
            await this.rollbackToSavepoint(connection, previous.savepoint);
          }
          
          if (previous) {
            CSReporter.info(`Nested rollback from level ${current.level} to level ${previous.level}${previous.savepoint ? ` (savepoint: ${previous.savepoint})` : ''}`);
          }
        }
      }
      
    } catch (error) {
      CSReporter.error('Failed to rollback transaction: ' + (error as Error).message);
      throw error;
    }
  }

  async savepoint(connection: DatabaseConnection, name: string): Promise<void> {
    try {
      await this.adapter.createSavepoint(connection, name);
      
      const stack = this.transactionStack.get(connection);
      if (stack && stack.length > 0) {
        const current = stack[stack.length - 1];
        if (current) {
          if (!current.savepoints) {
            current.savepoints = [];
          }
          current.savepoints.push({
            name,
            createdAt: Date.now()
          });
        }
      }
      
      CSReporter.info(`Savepoint created: ${name}`);
      
    } catch (error) {
      CSReporter.error('Failed to create savepoint: ' + (error as Error).message);
      throw error;
    }
  }

  private async releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    try {
      await this.adapter.releaseSavepoint(connection, name);
    } catch (error) {
      CSReporter.debug('Savepoint release not supported or failed: ' + (error as Error).message);
    }
  }

  private async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.adapter.rollbackToSavepoint(connection, name);
  }

  isInTransaction(connection: DatabaseConnection): boolean {
    const stack = this.transactionStack.get(connection);
    return stack !== undefined && stack.length > 0;
  }

  getTransactionLevel(connection: DatabaseConnection): number {
    const stack = this.transactionStack.get(connection);
    return stack ? stack.length : 0;
  }

  getActiveTransactions(): Map<DatabaseConnection, TransactionState[]> {
    return new Map(this.transactionStack);
  }

  async executeInTransaction<T>(
    connection: DatabaseConnection,
    operation: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const wasInTransaction = this.isInTransaction(connection);
    
    if (!wasInTransaction) {
      await this.begin(connection, options);
    }
    
    try {
      const result = await operation();
      
      if (!wasInTransaction) {
        await this.commit(connection);
      }
      
      return result;
    } catch (error) {
      if (!wasInTransaction) {
        await this.rollback(connection);
      }
      throw error;
    }
  }

  clearTransactionState(connection: DatabaseConnection): void {
    this.transactionStack.delete(connection);
  }

  private generateSavepointName(): string {
    return `sp_${Date.now()}_${++this.savepointCounter}`;
  }

  getTransactionStats(): {
    activeTransactions: number;
    totalSavepoints: number;
    longestTransaction: number | null;
  } {
    let totalSavepoints = 0;
    let longestTransaction: number | null = null;
    const now = Date.now();

    this.transactionStack.forEach(stack => {
      stack.forEach(state => {
        const duration = now - state.startTime;
        if (longestTransaction === null || duration > longestTransaction) {
          longestTransaction = duration;
        }
        
        if (state.savepoints) {
          totalSavepoints += state.savepoints.length;
        }
      });
    });

    return {
      activeTransactions: this.transactionStack.size,
      totalSavepoints,
      longestTransaction
    };
  }
}
