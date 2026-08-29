import { Injectable } from '@nestjs/common';

import chunk from 'lodash.chunk';
import { In } from 'typeorm';

import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { type ParticipantWithMessageId } from 'src/modules/messaging/message-import-manager/drivers/gmail/types/gmail-message.type';

@Injectable()
export class MessagingMessageParticipantService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly matchParticipantService: MatchParticipantService<MessageParticipantWorkspaceEntity>,
  ) {}

  public async saveMessageParticipants(
    participants: ParticipantWithMessageId[],
    workspaceId: string,
    transactionScope: WorkspaceTransactionScope,
  ): Promise<void> {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const messageParticipantRepository =
          transactionScope.getRepository<MessageParticipantWorkspaceEntity>(
            'messageParticipant',
          );

        const chunkedParticipants = chunk(participants, 200);

        const participantsToCreate: Pick<
          MessageParticipantWorkspaceEntity,
          'messageId' | 'handle' | 'displayName' | 'role'
        >[] = [];

        for (const participantsChunk of chunkedParticipants) {
          const existingParticipantsBasedOnMessageIds =
            await messageParticipantRepository.find({
              where: {
                messageId: In(
                  participantsChunk.map(
                    (participant) => participant.messageId,
                  ),
                ),
              },
            });

          const newParticipantsToCreate = participantsChunk
            .filter(
              (participant) =>
                !existingParticipantsBasedOnMessageIds.find(
                  (existingParticipant) =>
                    existingParticipant.messageId === participant.messageId &&
                    existingParticipant.handle === participant.handle &&
                    existingParticipant.displayName ===
                      participant.displayName &&
                    existingParticipant.role === participant.role,
                ),
            )
            .map((participant) => {
              return {
                messageId: participant.messageId,
                handle: participant.handle,
                displayName: participant.displayName,
                role: participant.role,
              };
            });

          participantsToCreate.push(...newParticipantsToCreate);
        }

        const chunkedParticipantsToCreate = chunk(participantsToCreate, 200);
        const createdParticipants: MessageParticipantWorkspaceEntity[] = [];

        for (const participantsToCreateChunk of chunkedParticipantsToCreate) {
          const { identifiers } = await messageParticipantRepository.insert(
            participantsToCreateChunk,
          );

          const insertedParticipants =
            await messageParticipantRepository.find({
              where: { id: In(identifiers.map(({ id }) => id)) },
            });

          createdParticipants.push(...insertedParticipants);
        }

        await this.matchParticipantService.matchParticipants({
          participants: createdParticipants,
          sourceRecordIds: [
            ...new Set(participants.map(({ messageId }) => messageId)),
          ],
          objectMetadataName: 'messageParticipant',
          matchWith: 'workspaceMemberAndPerson',
          transactionScope,
        });
      },
      authContext,
      { lite: true },
    );
  }
}
