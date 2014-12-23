var factories = require("../lib/misc/factories");

var AcknowledgeMessage_Schema = {
    name: "AcknowledgeMessage",
    id: factories.next_available_id(),
    fields: [
        { name: "protocolVersion"   , fieldType: "UInt32" , description: "The latest version of the OPC UA TCP protocol supported by the Server." },
        { name: "receiveBufferSize" , fieldType: "UInt32"  },
        { name: "sendBufferSize"    , fieldType: "UInt32" },
        { name: "maxMessageSize"    , fieldType: "UInt32" , description: "The maximum size for any request message."},
        { name: "maxChunkCount"     , fieldType: "UInt32" , description: "The maximum number of chunks in any request message." }
    ]
};

exports.AcknowledgeMessage_Schema = AcknowledgeMessage_Schema;
