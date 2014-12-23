var factories = require("../lib/misc/factories");

var HelloMessage_Schema = {
    name: "HelloMessage",
    id: factories.next_available_id(),
    fields: [
        { name: "protocolVersion"   , fieldType: "UInt32" , description: "The latest version of the OPC UA TCP protocol supported by the Client"},
        { name: "receiveBufferSize" , fieldType: "UInt32" , description: "The largest message that the sender can receive."},
        { name: "sendBufferSize"    , fieldType: "UInt32" , description: "The largest message that the sender will send." },
        { name: "maxMessageSize"    , fieldType: "UInt32" , description: "The maximum size for any response message."          },
        { name: "maxChunkCount"     , fieldType: "UInt32" , description: "The maximum number of chunks in any response message"},
        { name: "endpointUrl"       , fieldType: "UAString",description: "The URL of the Endpoint which the Client wished to connect to."}
    ]
};
exports.HelloMessage_Schema = HelloMessage_Schema;
