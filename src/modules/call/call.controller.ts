import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CallAckResponseDto } from './dto/call-response.dto';
import { CallService } from './call.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { ENGINE_NOT_READY_409 } from '../../common/openapi/engine-status-responses';

@ApiTags('calls')
@Controller('sessions/:sessionId/calls')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post(':callId/reject')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a ringing incoming call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID from the call.received event' })
  @ApiResponse({ status: 200, description: 'Call rejected', type: CallAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 404, description: 'Call not found or no longer ringing' })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async reject(@Param('sessionId') sessionId: string, @Param('callId') callId: string) {
    await this.callService.rejectCall(sessionId, callId);
    return { success: true };
  }
}
