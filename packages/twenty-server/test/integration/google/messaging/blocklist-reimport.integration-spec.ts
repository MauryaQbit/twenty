import { randomUUID } from 'node:crypto';

import {
  ConnectedAccountProvider,
  MessageChannelSyncStage,
} from 'twenty-shared/types';

import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { deleteOneOperationFactory } from 'test/integration/graphql/utils/delete-one-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { queryMessageChannel } from 'test/integration/utils/query-messaging.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

const HANDLE = 'gmail-blocklist-reimport@apple.dev';

const BLOCKED_HANDLES = [
  `blocked-1-${randomUUID()}@acme.com`,
  `blocked-2-${randomUUID()}@acme.com`,
  `blocked-3-${randomUUID()}@acme.com`,
];

describe('Blocklist reimport deduplication (integration)', () => {
  setupGoogleMock({ handle: HANDLE });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;
  let blocklistIds: string[];

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });

    const response = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'blocklist',
        objectMetadataPluralName: 'blocklists',
        gqlFields: 'id handle',
        data: BLOCKED_HANDLES.map((handle) => ({
          handle,
          workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
        })),
      }),
    );

    expect(response.body.errors).toBeUndefined();

    blocklistIds = response.body.data.createBlocklists.map(
      (blocklistItem: { id: string }) => blocklistItem.id,
    );

    await waitForAllJobsToFinish();

    await getCoreRepository<MessageChannelEntity>(MessageChannelEntity).update(
      { id: channel.channelId },
      {
        syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED,
        syncStageStartedAt: new Date(),
      },
    );
  }, 120000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  it('puts the channel back into a pending sync state once, regardless of how many blocklist entries for the same member were removed', async () => {
    await Promise.all(
      blocklistIds.map((recordId) =>
        makeGraphqlAPIRequest(
          deleteOneOperationFactory({
            objectMetadataSingularName: 'blocklist',
            gqlFields: 'id',
            recordId,
          }),
        ),
      ),
    );

    await waitForAllJobsToFinish();

    const channelAfter = await queryMessageChannel(channel);

    expect(channelAfter.syncStage).toBe(
      MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
    );
    expect(channelAfter.syncStageStartedAt).toBeNull();
  }, 120000);
});
