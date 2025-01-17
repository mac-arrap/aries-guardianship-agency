import { IControllerHandler } from 'aries-controller/controller.handler/controller.handler.interface';

export class ControllerHandlerMock implements IControllerHandler {
    handleAdminApiKey(agentId?: string): Promise<string> {
        return Promise.resolve('');
    }

    handleAgentId(): string {
        return '';
    }

    loadValues(): Promise<any> {
        return Promise.resolve(undefined);
    }

}
