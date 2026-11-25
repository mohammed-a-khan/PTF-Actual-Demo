/** An error caused by the user's input or the current state, with a message written for the user. */
export class UserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UserError';
    }
}
