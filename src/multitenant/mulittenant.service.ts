import { Injectable, CacheStore, CACHE_MANAGER, Inject, HttpService } from '@nestjs/common';
import { Logger } from 'protocol-common/logger';
import { ProtocolException } from 'protocol-common/protocol.exception';
import { ProtocolHttpService } from 'protocol-common/protocol.http.service';
import { ProtocolErrorCode } from 'protocol-common/protocol.errorcode';
import { WalletCreateDto } from './dtos/wallet.create.dto';

/**
 * Various calls to add/remove wallets from multitenant aca-py
 * TODO: right now aca-py only supports "managed" mode, meaning that the wallet_key is stored in memory. This is less secure
 *   than the "unmanaged" mode which would require the wallet_key to be passed in. However it's not implemented yet:
 *   https://github.com/hyperledger/aries-cloudagent-python/blob/main/aries_cloudagent/multitenant/admin/routes.py#L103
 *   Once unmanaged mode is implemented lets switch to use it.
 */
@Injectable()
export class MultitenantService {

    private http: ProtocolHttpService;
    private readonly DEFAULT_TTL_SECONDS: number = 3600;

    constructor(
        httpService: HttpService,
        @Inject(CACHE_MANAGER) private readonly cache: CacheStore
    ) {
        this.http = new ProtocolHttpService(httpService);
    }

    /**
     * Creates a wallet in the multitenant aca-py instance, and if set to auto-connection start a connection
     * Note that the ttl applies to just how long the token and data is cached, not to spinning up or down the agent (since it's multitenant)
     */
    public async createWallet(body: WalletCreateDto): Promise<any> {
        let walletId: string;
        let token: string;
        try {
            const result = await this.callCreateWallet(body);
            walletId = result.wallet_id;
            token = result.token;
        } catch (e) {
            // Handle already registered case
            if (e.details && (typeof e.details === 'string') && e.details.match(/Wallet with .+ already exists/g)) {
                Logger.log('Wallet already exists, fetching data from storage');
                [walletId, token] = await this.getTokenAndWalletId(body.walletName, body.walletKey);
            } else {
                throw new ProtocolException(ProtocolErrorCode.INTERNAL_SERVER_ERROR, 'Error creating wallet on multitenant', e);
            }
        }

        const ttl = (body.ttl === null || body.ttl === undefined) ? this.DEFAULT_TTL_SECONDS : body.ttl;

        // Add to cache
        await this.addWalletToCache(body.walletName, body.walletKey, walletId, token, ttl);

        // Handle auto connect
        let invitation = null;
        if (body.autoConnect) {
            invitation = await this.callCreateConnection(token);
        }

        // Only return token if requested to
        if (!body.returnToken) {
            token = null;
        }

        return {
            success: true,
            invitation,
            token,
        };
    }

    /**
     * Remove a wallet from multitenant and delete all credentials
     * TODO handle case where wallet isn't in cache
     */
    public async removeWallet(walletName: string, walletKey: string): Promise<any> {
        const agent: any = await this.cache.get(walletName);
        if (!agent) {
            Logger.error(`Attempted to remove wallet ${walletName} but it wasn't in cache`);
            throw new ProtocolException(ProtocolErrorCode.INTERNAL_SERVER_ERROR, 'Error removing wallet on multitenant');
        }
        return await this.callRemoveWallet(agent.walletId, walletKey);
    }

    /**
     * Saves wallet info to cache for easy future access
     * A ttl of 0 means store for Infinity
     */
    private async addWalletToCache(
        walletName: string, walletKey: string, walletId: string, token: string, ttl: number
    ): Promise<void> {
        ttl = (ttl === 0) ? Infinity: ttl;
        Logger.debug(`record cache limit set to: ${ttl}`);
        await this.cache.set(
            walletName,
            {
                adminApiKey: process.env.ACAPY_ADMIN_API_KEY,
                token,
                walletId,
                walletKey,
                ttl,
                multitenant: true,
            },
            {
                ttl
            }
        );
    }

    /**
     * Handle case where wallet has already be created and registered with multitenant
     * We check the cache and return the wallet id and token
     */
    private async getTokenAndWalletId(walletName: string, walletKey: string): Promise<[string, string]> {
        const agent: any = await this.cache.get(walletName);
        if (agent) {
            if (agent.walletKey === walletKey) {
                return [agent.walletId, agent.token];
            }
            Logger.warn(`Attempted to open wallet for walletName ${walletName} from cache but with wrong walletKey`);
        } else {
            Logger.warn(`Attempted to open wallet for walletName ${walletName} but it wasn't in cache`);
            return await this.handleCacheMiss(walletName, walletKey);
        }
        throw new ProtocolException(ProtocolErrorCode.INTERNAL_SERVER_ERROR, 'Error creating wallet on multitenant');
    }

    /**
     * If the wallet isn't in the cache we need find the wallet id and token from multitenant aca-py
     * First we fetch all the wallets and loop through them looking for the one that matches our wallet name
     * Then we use that wallet id and the passed in wallet key to fetch the token
     */
    private async handleCacheMiss(walletName: string, walletKey: string): Promise<[string,string]> {
        const allWallets = await this.callGetAllWallets();
        let walletId = null;
        for (const wallet of allWallets) {
            if (wallet.settings['wallet.name'] === walletName) {
                walletId = wallet.wallet_id;
                break; // we found our wallet so break out of loop
            }
        }
        if (!walletId) {
            Logger.warn(`Attempted to open wallet for walletName ${walletName} but it wasn't registered on multitenant`);
            throw new ProtocolException(ProtocolErrorCode.INTERNAL_SERVER_ERROR, 'Error creating wallet on multitenant');
        }
        const token = await this.callGetToken(walletId, walletKey);
        return [walletId, token];
    }

    // -- Remote calls can eventually be moved to their own mockable class -- //

    private async callGetAllWallets(): Promise<Array<any>> {
        Logger.debug('Fetching all wallets from multitenant');
        const url = `${process.env.MULTITENANT_URL}/multitenancy/wallets`;
        const req: any = {
            method: 'GET',
            url,
            headers: {
                'x-api-key': process.env.ACAPY_ADMIN_API_KEY
            },
        };
        const res = await this.http.requestWithRetry(req);
        return res.data.results;
    }

    private async callGetToken(walletId: string, walletKey: string): Promise<string> {
        Logger.debug(`Fetching token from multitenant ${walletId}`);
        const url = `${process.env.MULTITENANT_URL}/multitenancy/wallet/${walletId}/token`;
        const data = {
            wallet_key: walletKey
        };
        const req: any = {
            method: 'POST',
            url,
            data,
            headers: {
                'x-api-key': process.env.ACAPY_ADMIN_API_KEY
            },
        };
        const res = await this.http.requestWithRetry(req);
        return res.data.token;
    }

    private async callCreateWallet(body: WalletCreateDto): Promise<any> {
        Logger.debug(`Registering wallet with multitenant ${body.walletName}`);
        const url = `${process.env.MULTITENANT_URL}/multitenancy/wallet`;
        const data = {
            key_management_mode: 'managed', // TODO use unmanged when supported by aca-py (see note at top)
            wallet_dispatch_type: 'default',
            wallet_type: 'indy',
            label: body.label || 'multitenant',
            wallet_name: body.walletName,
            wallet_key: body.walletKey,
            wallet_webhook_urls: [
                body.controllerUrl || `${process.env.INTERNAL_URL}/v1/controller/${body.walletName}`
            ]
        };
        const req: any = {
            method: 'POST',
            url,
            data,
            headers: {
                'x-api-key': process.env.ACAPY_ADMIN_API_KEY
            },
        };
        const res = await this.http.requestWithRetry(req);
        return res.data;
    }

    /**
     * Remove wallet from multitenant and remove all credentials, note this requires a walletId UUID (not wallet name)
     */
    private async callRemoveWallet(walletId: string, walletKey: string): Promise<any> {
        Logger.log(`Removing wallet from multitenant ${walletId}`);
        const url = `${process.env.MULTITENANT_URL}/multitenancy/wallet/${walletId}/remove`;
        const data = {
            wallet_key: walletKey,
        };
        const req: any = {
            method: 'POST',
            url,
            data,
            headers: {
                'x-api-key': process.env.ACAPY_ADMIN_API_KEY
            },
        };
        const res = await this.http.requestWithRetry(req);
        return res.data;
    }

    private async callCreateConnection(token: string): Promise<any> {
        Logger.debug('Creating connection to wallet on multitenant');
        const url = `${process.env.MULTITENANT_URL}/connections/create-invitation`;
        const req: any = {
            method: 'POST',
            url,
            headers: {
                'x-api-key': process.env.ACAPY_ADMIN_API_KEY,
                'Authorization': 'Bearer ' + token
            },
        };

        const res = await this.http.requestWithRetry(req);
        return res.data.invitation;
    }
}
