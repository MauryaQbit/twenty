import { randomUUID } from 'node:crypto';

import { ConnectedAccountProvider } from 'twenty-shared/types';

import { googleCalendarEvent } from 'test/integration/google/mocks/google-calendar-event.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { findRecordIdsByFilter } from 'test/integration/utils/find-records-by-filter.util';
import { runCalendarChannelEventsImport } from 'test/integration/utils/run-calendar-channel-events-import.util';
import { runCalendarChannelListFetch } from 'test/integration/utils/run-calendar-channel-list-fetch.util';

const HANDLE = 'calendar-orphan-cleanup@apple.dev';

describe('Calendar orphan event cleanup on sync completion (integration)', () => {
  const survivorId = `google-calendar-event-${randomUUID()}`;
  const orphanId = `google-calendar-event-${randomUUID()}`;
  const survivorTitle = `Calendar event survivor ${randomUUID()}`;
  const orphanTitle = `Calendar event orphan ${randomUUID()}`;

  const gmail = setupGoogleMock({ handle: HANDLE });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });

    gmail.serveCalendarEvents([
      googleCalendarEvent({ id: survivorId, summary: survivorTitle }),
      googleCalendarEvent({ id: orphanId, summary: orphanTitle }),
    ]);

    await runCalendarChannelListFetch(channel.calendarChannelId);
    await runCalendarChannelEventsImport(channel.calendarChannelId);
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  it('deletes a calendar event once its last channel association is removed by a completed sync, leaving events with a surviving association untouched', async () => {
    const [survivorIdBefore] = await findRecordIdsByFilter(
      'calendarEvent',
      'calendarEvents',
      { title: { eq: survivorTitle } },
    );
    const [orphanIdBefore] = await findRecordIdsByFilter(
      'calendarEvent',
      'calendarEvents',
      { title: { eq: orphanTitle } },
    );

    expect(survivorIdBefore).toBeDefined();
    expect(orphanIdBefore).toBeDefined();

    gmail.serveCalendarEvents(
      [
        googleCalendarEvent({ id: survivorId, summary: survivorTitle }),
        googleCalendarEvent({
          id: orphanId,
          summary: orphanTitle,
          status: 'cancelled',
        }),
      ],
      { nextSyncToken: `orphan-cleanup-sync-token-${randomUUID()}` },
    );

    await runCalendarChannelListFetch(channel.calendarChannelId);
    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(
      await findRecordIdsByFilter(
        'calendarChannelEventAssociation',
        'calendarChannelEventAssociations',
        { calendarEventId: { eq: orphanIdBefore } },
      ),
    ).toHaveLength(0);
    expect(
      await findRecordIdsByFilter('calendarEvent', 'calendarEvents', {
        id: { eq: orphanIdBefore },
      }),
    ).toHaveLength(0);

    expect(
      await findRecordIdsByFilter(
        'calendarChannelEventAssociation',
        'calendarChannelEventAssociations',
        { calendarEventId: { eq: survivorIdBefore } },
      ),
    ).not.toHaveLength(0);
    expect(
      await findRecordIdsByFilter('calendarEvent', 'calendarEvents', {
        id: { eq: survivorIdBefore },
      }),
    ).toEqual([survivorIdBefore]);
  }, 60000);
});
