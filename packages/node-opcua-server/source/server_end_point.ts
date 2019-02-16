// tslint:disable:no-console
/**
 * @module opcua.server
 */
import * as async from "async";
import chalk from "chalk";
import { EventEmitter } from "events";
import * as net from "net";
import { Server,  Socket } from "net";
import * as path from "path";
import * as _ from "underscore";

import { assert } from "node-opcua-assert";
import { CertificateManager } from "node-opcua-certificate-manager";
import { Certificate, PrivateKeyPEM, split_der } from "node-opcua-crypto";
import { checkDebugFlag, make_debugLog } from "node-opcua-debug";
import { get_fully_qualified_domain_name } from "node-opcua-hostname";
import {
    fromURI,
    MessageSecurityMode,
    SecurityPolicy,
    ServerSecureChannelLayer, ServerSecureChannelParent,
    toURI
} from "node-opcua-secure-channel";
import { UserTokenType } from "node-opcua-service-endpoints";
import { EndpointDescription } from "node-opcua-service-endpoints";

const debugLog = make_debugLog(__filename);
const doDebug = checkDebugFlag(__filename);

const default_transportProfileUri = "http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary";

function dumpChannelInfo(channels: ServerSecureChannelLayer[]): void {

    function dumpChannel(channel: ServerSecureChannelLayer): void {

        console.log("------------------------------------------------------");
        console.log("            channelId = ", channel.channelId);
        console.log("             timeout  = ", channel.timeout);
        console.log("        remoteAddress = ", channel.remoteAddress);
        console.log("        remotePort    = ", channel.remotePort);
        console.log("");
        console.log("        bytesWritten  = ", channel.bytesWritten);
        console.log("        bytesRead     = ", channel.bytesRead);

        const socket = (channel as any).transport._socket;
        if (!socket) {
            console.log(" SOCKET IS CLOSED");
        }
    }
    for (const channel of channels) {
        dumpChannel(channel);
    }
}

/**
 * @method _prevent_DOS_Attack
 * @async
 * @param self
 * @param establish_connection
 * @private
 */
function _prevent_DDOS_Attack(
  self: OPCUAServerEndPoint,
  establish_connection: () => void
) {

    const nbConnections = self.activeChannelCount;

    if (nbConnections >= self.maxConnections) {
        // istanbul ignore next
        if (doDebug) {
            console.log(chalk.bgRed.white("PREVENTING DOS ATTACK => Closing unused channels"));
        }
        const unused_channels: ServerSecureChannelLayer[] = _.filter(self.getChannels(),
          (channel1: ServerSecureChannelLayer) => {
            return !channel1.isOpened && !channel1.hasSession;
        });
        if (unused_channels.length === 0) {
            // all channels are in used , we cannot get any

            // istanbul ignore next
            if (doDebug) {
                console.log("  - all channel are used !!!!");
                dumpChannelInfo(self.getChannels());
            }
            setImmediate(establish_connection);
            return;
        }
        // istanbul ignore next
        if (doDebug) {
            console.log("   - Unused channels that can be clobbered",
              _.map(unused_channels, (channel1: ServerSecureChannelLayer) => channel1.hashKey).join(" "));
        }
        const channel = unused_channels[0];

        channel.close(() => {
            // istanbul ignore next
            if (doDebug) {
                console.log("   _ Unused channel has been closed ", channel.hashKey);
            }
            self._unregisterChannel(channel);

            establish_connection();
        });
    } else {
        setImmediate(establish_connection);
    }
}

let OPCUAServerEndPointCounter = 0;
/**
 * OPCUAServerEndPoint a Server EndPoint.
 * @class OPCUAServerEndPoint
 *
 * A sever end point is listening to one port
 *
 * @param options {Object}
 * @param options.port                                  {Number} the tcp port
 * @param options.certificateChain                      {Buffer} the DER certificate chain
 * @param options.privateKey                            {String} PEM string of the private key
 * @param [options.defaultSecureTokenLifetime=600000]   {Number} the default secure token lifetime
 * @param [options.timeout=30000]                       {Number} the  timeout for the TCP HEL/ACK transaction (in ms)
 * @param [options.maxConnections = 20 ]                {Number} the maximum number of connection allowed on the
 *                                                               TCP server socket
 * @param options.serverInfo                            {ApplicationDescription}
 * @param [options.serverInfo.applicationUri]           {String}
 * @param [options.serverInfo.productUri]               {String}
 * @param [options.serverInfo.applicationName]          {LocalizedText}
 * @param [options.serverInfo.gatewayServerUri]         {String|null}
 * @param [options.serverInfo.discoveryProfileUri]      {String|null}
 * @param [options.serverInfo.discoveryUrls]            {String[]}
 * @param options.objectFactory
 * @param [options.certificateManager]
 * @constructor
 *
 * note:
 *   see OPCUA Release 1.03 part 4 page 108 7.1 ApplicationDescription
 */
export class OPCUAServerEndPoint extends EventEmitter implements ServerSecureChannelParent {

    public port: number;
    public certificateManager: CertificateManager;
    public defaultSecureTokenLifetime: number;
    public maxConnections: number;
    public timeout: number;
    public bytesWrittenInOldChannels: number;
    public bytesReadInOldChannels: number;
    public transactionsCountOldChannels: number;
    public securityTokenCountOldChannels: number;
    public serverInfo: any;
    public objectFactory: any;

    public _on_new_channel?: (channel: ServerSecureChannelLayer) => void ;
    public _on_close_channel?: (channel: ServerSecureChannelLayer) => void;
    private _certificateChain: any;
    private _privateKey: any;
    private _channels: { [key: string]: ServerSecureChannelLayer} ;
    private _server?: Server;
    private _endpoints: EndpointDescription[];
    private _listen_callback: any;
    private _started: boolean = false;
    private _counter = OPCUAServerEndPointCounter++;

    constructor(options: any) {

        super();

        assert(!options.hasOwnProperty("certificate"), "expecting a certificateChain instead");
        assert(options.hasOwnProperty("certificateChain"), "expecting a certificateChain");
        assert(options.hasOwnProperty("privateKey"));

        this.certificateManager = options.certificateManager;

        options = options || {};
        options.port = options.port || 0;

        this.port = parseInt(options.port, 10);
        assert(_.isNumber(this.port));

        this._certificateChain = options.certificateChain;
        this._privateKey = options.privateKey;

        this._channels = {};

        this.defaultSecureTokenLifetime = options.defaultSecureTokenLifetime || 600000;

        this.maxConnections = options.maxConnections || 20;

        this.timeout = options.timeout || 30000;

        this._server = undefined;

        this._setup_server();

        this._endpoints = [];

        this.objectFactory = options.objectFactory;

        this.bytesWrittenInOldChannels = 0;
        this.bytesReadInOldChannels = 0;
        this.transactionsCountOldChannels = 0;
        this.securityTokenCountOldChannels = 0;

        this.serverInfo = options.serverInfo;
        assert(_.isObject(this.serverInfo));
    }

    public dispose() {

        this._certificateChain = null;
        this._privateKey = null;

        assert(Object.keys(this._channels).length === 0, "OPCUAServerEndPoint channels must have been deleted");
        this._channels = {};
        this.serverInfo = null;

        this._endpoints = [];
        assert(this._endpoints.length === 0, "endpoints must have been deleted");
        this._endpoints = [];

        this._server = undefined;
        this._listen_callback = null;

        this.removeAllListeners();

    }

    public toString(): string {
        return "EndPoints " + this._counter + " port = " + this.port + " l = " + this._endpoints.length  ;
    }

    public getChannels(): ServerSecureChannelLayer[] {
      return _.values(this._channels);
    }

    public _dump_statistics() {

        const self = this;

        self._server!.getConnections((err: Error | null, count: number) => {
            debugLog(chalk.cyan("CONCURRENT CONNECTION = "), count);
        });
        debugLog(chalk.cyan("MAX CONNECTIONS = "), self._server!.maxConnections);
    }

    public _setup_server() {

        assert(!this._server);
        this._server = net.createServer({ pauseOnConnect: true }, this._on_client_connection.bind(this));

        // xx console.log(" Server with max connections ", self.maxConnections);
        this._server.maxConnections = this.maxConnections + 1; // plus one extra

        this._listen_callback = null;
        this._server.on("connection", (socket: NodeJS.Socket) => {

            // istanbul ignore next
            if (doDebug) {
                this._dump_statistics();
                debugLog("server connected  with : " +
                  (socket as any).remoteAddress + ":" + (socket as any).remotePort);
            }

        }).on("close", () => {
            debugLog("server closed : all connections have ended");
        }).on("error", (err: Error) => {
            // this could be because the port is already in use
            debugLog(chalk.red.bold("server error: "), err.message);
        });
    }

    public _on_client_connection(socket: Socket) {

        // a client is attempting a connection on the socket
        (socket as any).setNoDelay(true);

        debugLog("OPCUAServerEndPoint#_on_client_connection", this._started);
        if (!this._started) {
            debugLog(chalk.bgWhite.cyan("OPCUAServerEndPoint#_on_client_connection " +
              "SERVER END POINT IS PROBABLY SHUTTING DOWN !!! - Connection is refused"));
            socket.end();
            return;
        }

        const establish_connection = () => {

            const nbConnections = Object.keys(this._channels).length;
            debugLog(" nbConnections ", nbConnections, " self._server.maxConnections",
              this._server!.maxConnections, this.maxConnections);
            if (nbConnections >= this.maxConnections) {
                debugLog(chalk.bgWhite.cyan("OPCUAServerEndPoint#_on_client_connection " +
                  "The maximum number of connection has been reached - Connection is refused"));
                socket.end();
                (socket as any).destroy();
                return;
            }

            debugLog("OPCUAServerEndPoint._on_client_connection successful => New Channel");

            const channel = new ServerSecureChannelLayer({
                defaultSecureTokenLifetime: this.defaultSecureTokenLifetime,
                // objectFactory: this.objectFactory,
                parent: this,
                timeout: this.timeout
            });

            socket.resume();

            this._preregisterChannel(channel);

            channel.init(socket, (err?: Error) => {
                this._unpreregisterChannel(channel);
                debugLog(chalk.yellow.bold("Channel#init done"), err);
                if (err) {
                    socket.end();
                } else {
                    debugLog("server receiving a client connection");
                    this._registerChannel(channel);
                }
            });

            channel.on("message", (message: any) => {
                // forward
                this.emit("message", message, channel, this);
            });
        };
        // Each SecureChannel exists until it is explicitly closed or until the last token has expired and the overlap
        // period has elapsed. A Server application should limit the number of SecureChannels.
        // To protect against misbehaving Clients and denial of service attacks, the Server shall close the oldest
        // SecureChannel that has no Session assigned before reaching the maximum number of supported SecureChannels.
        _prevent_DDOS_Attack(this, establish_connection);

    }

    /**
     * @method getCertificate
     * Returns the X509 DER form of the server certificate
     * @return {Buffer}
     */
    public getCertificate() {
        return split_der(this._certificateChain)[0];
    }

    /**
     * Returns the X509 DER form of the server certificate
     */
    public getCertificateChain(): Certificate {
        return this._certificateChain;
    }

    /**
     * the private key
     */
    public getPrivateKey(): PrivateKeyPEM {
        return this._privateKey;
    }

    /**
     * The number of active channel on this end point.
     */
    public get currentChannelCount(): number {
        return Object.keys(this._channels).length;
    }

    /**
     * @method getEndpointDescription
     * @param securityMode
     * @param securityPolicy
     * @return endpoint_description {EndpointDescription|null}
     */
    public getEndpointDescription(
      securityMode: MessageSecurityMode,
      securityPolicy: SecurityPolicy
    ): EndpointDescription | null {

        const endpoints = this.endpointDescriptions();
        const arr = _.filter(endpoints, matching_endpoint.bind(this, securityMode, securityPolicy));
        assert(arr.length === 0 || arr.length === 1);
        return arr.length === 0 ? null : arr[0];
    }

    public addEndpointDescription(
      securityMode: MessageSecurityMode,
      securityPolicy: SecurityPolicy,
      options: any
    ) {
        options = options || {};
        options.allowAnonymous = (options.allowAnonymous === undefined) ? true : options.allowAnonymous;

        if (securityMode === MessageSecurityMode.None && securityPolicy !== SecurityPolicy.None) {
            throw new Error(" invalid security ");
        }
        if (securityMode !== MessageSecurityMode.None && securityPolicy === SecurityPolicy.None) {
            throw new Error(" invalid security ");
        }
        //
        const endpoint_desc = this.getEndpointDescription(securityMode, securityPolicy);
        if (endpoint_desc) {
            throw new Error(" endpoint already exist");
        }
        const port = this.port;

        options.hostname = options.hostname || get_fully_qualified_domain_name();

        this._endpoints.push(_makeEndpointDescription({
            port,
            server: this.serverInfo,
            serverCertificateChain: this.getCertificateChain(),

            securityMode,
            securityPolicy,

            allowAnonymous: options.allowAnonymous,
            allowUnsecurePassword: options.allowUnsecurePassword,
            resourcePath: options.resourcePath,

            hostname: options.hostname,
            restricted: !!options.restricted
        }));
    }

    public addRestrictedEndpointDescription(options: any) {
        options = _.clone(options);
        options.restricted = true;
        return this.addEndpointDescription(MessageSecurityMode.None, SecurityPolicy.None, options);
    }

    public addStandardEndpointDescriptions(options: any) {

        options = options || {};

        options.securityModes = options.securityModes || defaultSecurityModes;
        options.securityPolicies = options.securityPolicies || defaultSecurityPolicies;

        if (options.securityModes.indexOf(MessageSecurityMode.None) >= 0) {
            this.addEndpointDescription(MessageSecurityMode.None, SecurityPolicy.None, options);
        } else {
            if (!options.disableDiscovery) {
                this.addRestrictedEndpointDescription(options);
            }
        }
        for (const securityMode  of  options.securityModes) {
            if (securityMode === MessageSecurityMode.None) {
                continue;
            }
            for (const securityPolicy of options.securityPolicies) {
                if (securityPolicy === SecurityPolicy.None) {
                    continue;
                }
                this.addEndpointDescription(securityMode, securityPolicy, options);
            }
        }
    }

    /**
     * returns the list of end point descriptions.
     */
    public endpointDescriptions(): EndpointDescription[] {
        return this._endpoints;
    }

    public _preregisterChannel(channel: ServerSecureChannelLayer) {
        // _preregisterChannel is used to keep track of channel for which
        // that are in early stage of the hand shaking process.
        // e.g HEL/ACK and OpenSecureChannel may not have been received yet
        // as they will need to be interrupted when OPCUAServerEndPoint is closed
        assert(this._started, "OPCUAServerEndPoint must be started");

        assert(!this._channels.hasOwnProperty(channel.hashKey), " channel already preregistered!");

        this._channels[channel.hashKey] = channel;

        (channel as any)._unpreregisterChannelEvent = () => {
            debugLog("Channel received an abort event during the preregistration phase");
            this._unpreregisterChannel(channel);
            channel.dispose();
        };
        channel.on("abort", (channel as any)._unpreregisterChannelEvent);
    }

    public _unpreregisterChannel(channel: ServerSecureChannelLayer) {

        if (!this._channels[channel.hashKey]) {
            debugLog("Already un preregistered ?", channel.hashKey);
            return;
        }

        delete this._channels[channel.hashKey];
        assert(_.isFunction((channel as any)._unpreregisterChannelEvent));
        channel.removeListener("abort", (channel as any)._unpreregisterChannelEvent);
        (channel as any)._unpreregisterChannelEvent = null;
    }

    /**
     * @method _registerChannel
     * @param channel
     * @private
     */
    public _registerChannel(channel: ServerSecureChannelLayer) {

        if (this._started) {

            debugLog(chalk.red("_registerChannel = "), "channel.hashKey = ", channel.hashKey);

            assert(!this._channels[channel.hashKey]);
            this._channels[channel.hashKey] = channel;

            channel._rememberClientAddressAndPort();
            /**
             * @event newChannel
             * @param channel
             */
            this.emit("newChannel", channel);

            channel.on("abort", () => {
                this._unregisterChannel(channel);
            });

        } else {
            debugLog("OPCUAServerEndPoint#_registerChannel called when end point is shutdown !");
            debugLog("  -> channel will be forcefully terminated");
            channel.close();
            channel.dispose();
        }
    }

    /**
     * @method _unregisterChannel
     * @param channel
     * @private
     */
    public _unregisterChannel(channel: ServerSecureChannelLayer): void {

        debugLog("_un-registerChannel channel.hashKey", channel.hashKey);
        if (!this._channels.hasOwnProperty(channel.hashKey)) {
            return;
        }

        assert(this._channels.hasOwnProperty(channel.hashKey), "channel is not registered");

        /**
         * @event closeChannel
         * @param channel
         */
        this.emit("closeChannel", channel);

        // keep trace of statistics data from old channel for our own accumulated stats.
        this.bytesWrittenInOldChannels += channel.bytesWritten;
        this.bytesReadInOldChannels += channel.bytesRead;
        this.transactionsCountOldChannels += channel.transactionsCount;
        delete this._channels[channel.hashKey];

        // istanbul ignore next
        if (doDebug) {
            this._dump_statistics();
            debugLog("un-registering channel  - Count = ", this.currentChannelCount);
        }

        /// channel.dispose();
    }

    public _end_listen(err?: Error) {
        assert(_.isFunction(this._listen_callback));
        this._listen_callback(err);
        this._listen_callback = null;
    }

    /**
     * @method listen
     * @async
     */
    public listen(callback: (err?: Error) => void) {

        assert(_.isFunction(callback));
        assert(!this._started, "OPCUAServerEndPoint is already listening");

        this._listen_callback = callback;

        this._server!.on("error", (err: Error) => {
            debugLog(chalk.red.bold(" error") + " port = " + this.port, err);
            this._started = false;
            this._end_listen(err);
        });
        this._server!.on("listening", () => {
            debugLog("server is listening");
        });
        this._server!.listen(this.port, /*"::",*/ (err?: Error) => { // 'listening' listener
            debugLog(chalk.green.bold("LISTENING TO PORT "), this.port, "err  ", err);
            assert(!err, " cannot listen to port ");
            this._started = true;
            this._end_listen();
        });
    }

    public killClientSockets(callback: (err?: Error) => void) {

        for (const channel of this.getChannels()) {

            const hacked_channel = channel as any;
            if (hacked_channel.transport && hacked_channel.transport._socket) {
                hacked_channel.transport._socket.close();
                hacked_channel.transport._socket.destroy();
                hacked_channel.transport._socket.emit("error", new Error("EPIPE"));
            }
        }
        callback();
    }

    public suspendConnection(callback: (err?: Error) => void) {

        assert(this._started);
        this._server!.close(() => {
            this._started = false;
        });
        this._started = false;
        callback();
    }

    public restoreConnection(callback: (err?: Error) => void) {
        this.listen(callback);
    }

    /**
     * @method shutdown
     * @async
     */
    public shutdown(callback: (err?: Error) => void) {

        debugLog("OPCUAServerEndPoint#shutdown ");

        if (this._started) {
            // make sure we don't accept new connection any more ...
            this.suspendConnection(() => {
                // shutdown all opened channels ...
                const _channels = _.values(this._channels);
                async.each(_channels, shutdown_channel.bind(this), (err?: Error| null) => {
                    if (!(Object.keys(this._channels).length === 0)) {
                        console.log(" Bad !");
                    }
                    assert(Object.keys(this._channels).length === 0, "channel must have unregistered themselves");
                    callback(err || undefined);
                });
            });
        } else {
            callback();
        }
    }

    /**
     * @method start
     * @async
     * @param callback
     */
    public start(callback: (err?: Error) => void): void {
        assert(_.isFunction(callback));
        this.listen(callback);
    }

    public get bytesWritten(): number {
        const chnls = _.values(this._channels);
        return this.bytesWrittenInOldChannels + chnls.reduce(
          (accumulated: number, channel: ServerSecureChannelLayer) => {
              return accumulated + channel.bytesWritten;
          }, 0);
    }

    public get bytesRead(): number {
        const chnls = _.values(this._channels);
        return this.bytesReadInOldChannels + chnls.reduce(
          (accumulated: number, channel: ServerSecureChannelLayer) => {
              return accumulated + channel.bytesRead;
          }, 0);
    }

    public get transactionsCount(): number {
        const chnls = _.values(this._channels);
        return this.transactionsCountOldChannels + chnls.reduce(
          (accumulated: number, channel: ServerSecureChannelLayer) => {
              return accumulated + channel.transactionsCount;
          }, 0);
    }

    public get securityTokenCount(): number {
        const chnls = _.values(this._channels);
        return this.securityTokenCountOldChannels + chnls.reduce(
          (accumulated: number, channel: ServerSecureChannelLayer) => {
              return accumulated + channel.securityTokenCount;
          }, 0);
    }

    public get activeChannelCount(): number {
        return Object.keys(this._channels).length;
    }

}

/**
 * @method _makeEndpointDescription
 * @param options.port
 * @param options.serverCertificate
 * @param options.securityMode
 * @param options.securityPolicy
 * @param options.securityLevel              {Number}
 * @param options.server.applicationUri      {String}
 * @param options.server.productUri          {String}
 * @param options.server.applicationName     {LocalizedText} // {text: "SampleServer", locale: null},
 * @param options.server.applicationType     {ApplicationType}
 * @param options.server.gatewayServerUri    {String}
 * @param options.server.discoveryProfileUri {String}
 * @param options.server.discoveryUrls       {String}
 * @param [options.resourcePath=""]          {String} resource Path is a string added at the end
 *                                                   of the url such as "/UA/Server"
 * @param [options.hostname=get_fully_qualified_domain_name()] {string} default hostname
 * @param options.restricted                 {boolean}
 * @param [options.allowAnonymous=true]      {boolean} allow anonymous connection
 * @param [options.allowUnsecurePassword=false] {boolean} allow unencrypted password in userNameIdentity (
 * @return {EndpointDescription}
 * @private
 */
function _makeEndpointDescription(options: any) {

    assert(_.isFinite(options.port), "expecting a valid port number");
    assert(options.hasOwnProperty("serverCertificateChain"));
    assert(!options.hasOwnProperty("serverCertificate"));
    assert(options.securityMode); // s.MessageSecurityMode
    assert(options.securityPolicy);
    assert(_.isObject(options.server));
    assert(options.hostname && (typeof options.hostname === "string"));
    assert(_.isBoolean(options.restricted));

    options.securityLevel = (options.securityLevel === undefined) ? 3 : options.securityLevel;
    assert(_.isFinite(options.securityLevel), "expecting a valid securityLevel");

    const securityPolicyUri = toURI(options.securityPolicy);

    // resource Path is a string added at the end of the url such as "/UA/Server"
    const resourcePath = options.resourcePath || "";

    const userIdentityTokens = [];

    if (options.securityPolicy === SecurityPolicy.None) {

        if (options.allowUnsecurePassword) {
            userIdentityTokens.push({
                policyId: "username_unsecure",
                tokenType: UserTokenType.UserName,

                issuedTokenType: null,
                issuerEndpointUrl: null,
                securityPolicyUri: null
            });
        }

        userIdentityTokens.push({
            policyId: "username_basic256",
            tokenType: UserTokenType.UserName,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic256
        });

        userIdentityTokens.push({
            policyId: "username_basic128",
            tokenType: UserTokenType.UserName,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic128Rsa15
        });

        userIdentityTokens.push({
            policyId: "username_basic256Sha256",
            tokenType: UserTokenType.UserName,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic256Sha256
        });

        userIdentityTokens.push({
            policyId: "certificate_basic256Sha256",
            tokenType: UserTokenType.Certificate,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic256Sha256
        });

        // X509
        userIdentityTokens.push({
            policyId: "certificate_basic256",
            tokenType: UserTokenType.UserName,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic256
        });

        userIdentityTokens.push({
            policyId: "certificate_basic128",
            tokenType: UserTokenType.UserName,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic128Rsa15
        });

        userIdentityTokens.push({
            policyId: "certificate_basic256Sha256",
            tokenType: UserTokenType.UserName,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic256Sha256
        });

        userIdentityTokens.push({
            policyId: "certificate_basic256Sha256",
            tokenType: UserTokenType.Certificate,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: SecurityPolicy.Basic256Sha256
        });

    } else {
        // note:
        //  when channel session security is not "None",
        //  userIdentityTokens can be left to null.
        //  in this case this mean that secure policy will be the same as connection security policy
        userIdentityTokens.push({
            policyId: "usernamePassword",
            tokenType: UserTokenType.UserName,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: null
        });

        userIdentityTokens.push({
            policyId: "certificateX509",
            tokenType: UserTokenType.Certificate,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: null
        });

    }

    if (options.allowAnonymous) {

        userIdentityTokens.push({
            policyId: "anonymous",
            tokenType: UserTokenType.Anonymous,

            issuedTokenType: null,
            issuerEndpointUrl: null,
            securityPolicyUri: null
        });
    }

    const endpointUrl = "opc.tcp://" + options.hostname + ":" +
      path.join("" + options.port, resourcePath).replace(/\\/g, "/");
    // return the endpoint object
    const endpoint = new EndpointDescription({

        endpointUrl,
        server: options.server,
        serverCertificate: options.serverCertificateChain,

        securityMode: options.securityMode,
        securityPolicyUri,
        userIdentityTokens,

        securityLevel: options.securityLevel,
        transportProfileUri: default_transportProfileUri
    });

    (endpoint as any).restricted = options.restricted;

    return endpoint;

}

/**
 * @method matching_endpoint
 * @param endpoint
 * @param securityMode
 * @param securityPolicy
 * @return {Boolean}
 *
 */
function matching_endpoint(
  securityMode: MessageSecurityMode,
  securityPolicy: SecurityPolicy,
  endpoint: EndpointDescription
): boolean {

    assert(endpoint instanceof EndpointDescription);
    const endpoint_securityPolicy = fromURI(endpoint.securityPolicyUri);
    return (endpoint.securityMode === securityMode && endpoint_securityPolicy === securityPolicy);
}

const defaultSecurityModes = [
    MessageSecurityMode.None,
    MessageSecurityMode.Sign,
    MessageSecurityMode.SignAndEncrypt
];
const defaultSecurityPolicies = [
    SecurityPolicy.Basic128Rsa15,
    SecurityPolicy.Basic256,
// xx UNUSED!!    SecurityPolicy.Basic256Rsa15,
    SecurityPolicy.Basic256Sha256
];

/**
 * @method shutdown_channel
 * @param channel
 * @param inner_callback
 */
function shutdown_channel(
  this: OPCUAServerEndPoint,
  channel: ServerSecureChannelLayer,
  inner_callback: (err?: Error) => void
) {
    assert(_.isFunction(inner_callback));
    channel.once("close", () => {
        // xx console.log(" ON CLOSED !!!!");
    });

    channel.close(() => {
        this._unregisterChannel(channel);
        setImmediate(inner_callback);
    });
}
