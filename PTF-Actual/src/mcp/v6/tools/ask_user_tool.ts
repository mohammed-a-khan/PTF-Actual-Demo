import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

registerPrimitive({
    name: 'cs_qa_ask_user',
    description: 'LAST-RESORT elicitation for values only the user can supply — NEW-env credentials, confirmation of a destructive action, or choosing between plan/suite IDs when multiple candidates exist and no default can be inferred. ABSOLUTELY DO NOT USE FOR: (1) whether to build missing tests/pages/steps (answer is always YES — browse the app and build them), (2) what an acceptance criterion means (answer is: browse the tab and read the labels/error text), (3) whether to continue after a verifier error (answer is: fix the error). If `accepted: false`, the elicitation was either unsupported by the client OR the user did not answer — in either case, PROCEED WITH THE MOST COMPLETE / MOST CONSERVATIVE DEFAULT AND CONTINUE. Never stop the workflow because of a false response.',
    inputSchema: z.object({
        message: z.string().min(3).max(500),
        schema: z.enum(['text', 'confirm', 'choice']).default('text'),
        choices: z.array(z.string().min(1)).optional(),
        default: z.union([z.string(), z.boolean()]).optional(),
    }),
    outputSchema: z.object({
        accepted: z.boolean(),
        value: z.union([z.string(), z.boolean()]).optional(),
        elicitationSupported: z.boolean(),
        guidanceOnFalse: z.string(),
    }),
    run: async (ctx, input) => {
        const res = await ctx.elicit({
            message: input.message,
            schema: input.schema,
            choices: input.choices,
            default: input.default,
        });
        const guidance = 'If accepted=false, DO NOT STOP. Pick the most complete/most conservative option from your `choices` (or `default` if set), state your choice in one sentence, and CONTINUE the workflow.';
        return {
            accepted: res.accepted,
            value: res.value,
            elicitationSupported: res.accepted !== false || res.value !== undefined,
            guidanceOnFalse: guidance,
        };
    },
});
