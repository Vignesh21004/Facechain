// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MatchRegistry {
    struct Record {
        bytes32 imageHash;
        bytes32 faceDigest;
        string sourceUrl;
        string sourceDomain;
        uint16 confidenceBps;
        uint64 createdAt;
        address submittedBy;
    }

    mapping(bytes32 => Record) public records;
    bytes32[] public recordIds;

    event MatchAnchored(
        bytes32 indexed recordId,
        bytes32 indexed imageHash,
        bytes32 faceDigest,
        string sourceUrl,
        uint16 confidenceBps,
        uint64 createdAt,
        address indexed submittedBy
    );

    function anchorMatch(
        bytes32 recordId,
        bytes32 imageHash,
        bytes32 faceDigest,
        string calldata sourceUrl,
        string calldata sourceDomain,
        uint16 confidenceBps
    ) external {
        require(records[recordId].createdAt == 0, "record exists");
        require(confidenceBps <= 10000, "confidence > 100%");

        records[recordId] = Record({
            imageHash: imageHash,
            faceDigest: faceDigest,
            sourceUrl: sourceUrl,
            sourceDomain: sourceDomain,
            confidenceBps: confidenceBps,
            createdAt: uint64(block.timestamp),
            submittedBy: msg.sender
        });
        recordIds.push(recordId);
        emit MatchAnchored(recordId, imageHash, faceDigest, sourceUrl, confidenceBps, uint64(block.timestamp), msg.sender);
    }

    function getRecord(bytes32 recordId) external view returns (Record memory) {
        return records[recordId];
    }

    function count() external view returns (uint256) {
        return recordIds.length;
    }
}
