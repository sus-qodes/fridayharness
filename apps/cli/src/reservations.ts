import type { FileReservationView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { shortTime, table } from './output.js';

/** File reservations from the operator's side (plan M5c, ADR-0025). */

export function registerReservationCommands(program: Command, g: () => GlobalOptions): void {
  const reservations = program
    .command('reservations')
    .description('exclusive reservations of conflict-prone files (lockfiles, migrations, shared contracts)')
    .option('--all', 'include released and expired reservations')
    .action(async (o: { all?: boolean }) => {
      const { client } = operator(g());
      const r = await client.get<{ mode: string; required: string[]; reservations: FileReservationView[] }>(
        `${client.projectPath('/file-reservations')}${o.all ? '?all=true' : ''}`,
      );
      out(g(), r, () =>
        [
          r.reservations.length
            ? table(
                ['RESERVATION', 'TASK', 'PATTERN', 'STATUS', 'VIA', 'SINCE'],
                r.reservations.map((x) => [
                  x.reservation_id,
                  x.task_id,
                  x.pattern,
                  x.status,
                  x.via,
                  shortTime(x.acquired_at),
                ]),
                { maxWidth: 60 },
              )
            : 'No file is reserved.',
          r.mode === 'off'
            ? 'Reservations are off (reservations.mode in .friday/config.yaml).'
            : `Conflict-prone files: ${r.required.length ? r.required.join(', ') : '(none configured; set reservations.required)'}`,
        ].join('\n'),
      );
    });
  reservations
    .command('release <reservation>')
    .description('end a reservation early, so other tasks may change those files')
    .option('--note <text>', 'why')
    .action(async (id: string, o: { note?: string }) => {
      const { client } = operator(g());
      const r = await client.post<{ reservation: FileReservationView }>(
        client.projectPath(`/file-reservations/${id}/release`),
        o.note ? { note: o.note } : {},
      );
      out(g(), r, () => `${r.reservation.reservation_id} (${r.reservation.pattern}): ${r.reservation.status}`);
    });

  program
    .command('reserve <pattern>')
    .description('reserve a file or glob for a task, so no other task changes it until this one ends')
    .requiredOption('--task <task>', 'the task that holds the reservation')
    .option('--note <text>', 'why')
    .action(async (pattern: string, o: { task: string; note?: string }) => {
      const { client } = operator(g());
      const r = await client.post<{ reservation: FileReservationView }>(client.projectPath('/file-reservations'), {
        task_id: o.task,
        pattern,
        ...(o.note ? { note: o.note } : {}),
      });
      out(
        g(),
        r,
        () => `Reserved ${r.reservation.pattern} for ${r.reservation.task_id} (${r.reservation.reservation_id}).`,
      );
    });
}
